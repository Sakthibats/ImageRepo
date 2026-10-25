import { Hono } from 'hono';
import type { Env } from './types.js';
import { BACKOFF, MAX_ATTEMPTS } from './inbox.js';

/**
 * Re-running a stage over media already in the library: a new stage, or a
 * new version of one, which is what "bumping a version means redo this"
 * comes down to. The Worker does no processing: the service claims media
 * here, runs the stage from what R2 holds, and reports back. Uploads run
 * every stage when they arrive (inbox.ts); this is only for what is already in.
 *
 * Each (stage, version, kind) is one pass through media in id order, its
 * place kept in stage_sweeps. A claim carries on from there, so the library
 * is read once per version, and a finished pass costs a row to check: on the
 * free plan a scan of the library on every idle poll would use the day's
 * reads in minutes.
 */
export const stages = new Hono<{ Bindings: Env }>({ strict: false });

const NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const ID = /^[0-9a-f]{32}$/;
const now = () => Math.floor(Date.now() / 1000);

/**
 * Media handed out a day, across every pass: about a quarter of the free
 * plan's 100k rows written a day, so uploads and edits always have room.
 */
export const RERUNS_PER_DAY = 5000;
/** Each item is a few bound parameters in one IN (...); D1 allows 100. */
const CLAIM_MAX = 50;

/**
 * True for a media_stages row `s` that keeps a media item out of the pass for
 * version `v` at time `t`: done at that version or later, held by a live
 * claim, or given up on.
 */
const settled = (v: string, t: string) => `(
  (s.state = 'done' AND s.version >= ${v})
  OR (s.state = 'claimed' AND s.version = ${v} AND s.lease_until > ${t})
  OR (s.state = 'failed' AND s.version = ${v} AND s.attempts >= ${MAX_ATTEMPTS})
)`;

/** Seconds a failed re-run waits before it is handed out again, after `attempts` (SQL). */
const backoff = (attempts: string) =>
  `CASE ${BACKOFF.slice(0, -1).map((s, i) => `WHEN ${attempts} <= ${i} THEN ${s}`).join(' ')} ELSE ${BACKOFF.at(-1)} END`;

/**
 * Up to `limit` media of one kind to re-run `stage` at `version` on: first
 * any whose last attempt failed and has waited out its backoff, or whose
 * claim lapsed; then the next stretch of the pass. Each item says what the
 * re-run needs beyond the file in orig/: a stripped JPEG or PNG has lost its
 * EXIF orientation, so it comes from raw_meta.
 */
stages.post('/claim', async (c) => {
  const b = await c.req.json<{
    stage?: string; version?: number; kind?: string; limit?: number;
    runner?: string; leaseSeconds?: number;
  }>().catch(() => ({} as Record<string, never>));

  const stage = b.stage ?? '';
  const version = Number(b.version);
  const kind = b.kind;
  if (!NAME.test(stage) || !Number.isInteger(version) || version < 1 || (kind !== 'photo' && kind !== 'video')) {
    return c.json({ error: 'stage, integer version and kind (photo or video) required' }, 400);
  }
  const limit = Math.min(Math.max(Math.floor(Number(b.limit) || 10), 1), CLAIM_MAX);
  const lease = Math.min(Math.max(Number(b.leaseSeconds ?? 900), 60), 6 * 3600);
  const runner = String(b.runner ?? 'unknown').slice(0, 40);
  const db = c.env.DB;
  const ts = now();
  const today = Math.floor(ts / 86400);

  const used = await db.prepare(
    'SELECT COALESCE(SUM(claimed), 0) AS n FROM stage_sweeps WHERE day = ?1'
  ).bind(today).first<{ n: number }>();
  let room = Math.min(limit, RERUNS_PER_DAY - (used?.n ?? 0));
  if (room <= 0) return c.json({ items: [], capped: true, done: false });

  // Retries: an index range on (stage, version, state), so nearly free when there are none.
  const retried = (await db.prepare(`
    UPDATE media_stages SET state = 'claimed', runner = ?3, lease_until = ?4, updated_at = ?5
    WHERE stage = ?1 AND media_id IN (
      SELECT s.media_id FROM media_stages s JOIN media m ON m.id = s.media_id
      WHERE s.stage = ?1 AND s.version = ?2 AND s.state IN ('failed', 'claimed')
        AND (s.state = 'claimed' OR s.attempts < ${MAX_ATTEMPTS})
        AND COALESCE(s.lease_until, 0) <= ?5 AND m.kind = ?6
      LIMIT ?7)
    RETURNING media_id
  `).bind(stage, version, runner, ts + lease, ts, kind, room).all<{ media_id: string }>()).results;
  room -= retried.length;

  const sweep = await db.prepare(
    'SELECT after, finished_at FROM stage_sweeps WHERE stage = ?1 AND version = ?2 AND kind = ?3'
  ).bind(stage, version, kind).first<{ after: string; finished_at: number | null }>();
  let after = sweep?.after ?? '';
  let finished = Boolean(sweep?.finished_at);
  let swept: { media_id: string }[] = [];

  if (room > 0 && !finished) {
    // The pass, from where it stopped: everything between there and the last
    // item claimed was already settled, and is not read again.
    swept = (await db.prepare(`
      INSERT INTO media_stages (media_id, stage, version, state, attempts, error, runner, updated_at, lease_until)
      SELECT m.id, ?1, ?2, 'claimed', 0, NULL, ?3, ?5, ?4
      FROM media m LEFT JOIN media_stages s ON s.media_id = m.id AND s.stage = ?1
      WHERE m.kind = ?6 AND m.id > ?7 AND (s.media_id IS NULL OR NOT ${settled('?2', '?5')})
      ORDER BY m.id LIMIT ?8
      ON CONFLICT(media_id, stage) DO UPDATE SET
        version = excluded.version, state = 'claimed', runner = excluded.runner, error = NULL,
        attempts = CASE WHEN media_stages.version = excluded.version THEN media_stages.attempts ELSE 0 END,
        lease_until = excluded.lease_until, updated_at = excluded.updated_at
      RETURNING media_id
    `).bind(stage, version, runner, ts + lease, ts, kind, after, room).all<{ media_id: string }>()).results;
    for (const r of swept) if (r.media_id > after) after = r.media_id;
    finished = swept.length < room;
  }

  const claimed = retried.length + swept.length;
  if (claimed || (finished && !sweep?.finished_at) || !sweep) {
    // MAX: two runners claiming at once must never move the place back.
    await db.prepare(`
      INSERT INTO stage_sweeps (stage, version, kind, after, finished_at, day, claimed)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      ON CONFLICT(stage, version, kind) DO UPDATE SET
        after = MAX(stage_sweeps.after, excluded.after),
        finished_at = COALESCE(stage_sweeps.finished_at, excluded.finished_at),
        claimed = CASE WHEN stage_sweeps.day = excluded.day THEN stage_sweeps.claimed + excluded.claimed
                       ELSE excluded.claimed END,
        day = excluded.day
    `).bind(stage, version, kind, after, finished ? ts : null, today, claimed).run();
  }

  const ids = [...retried, ...swept].map((r) => r.media_id);
  const items = ids.length ? (await db.prepare(`
    SELECT id, kind, ext, json_extract(raw_meta, '$.Orientation') AS orientation
    FROM media WHERE id IN (${ids.map((_, i) => `?${i + 1}`).join(',')}) ORDER BY id
  `).bind(...ids).all<{ id: string; kind: string; ext: string; orientation: number | null }>()).results : [];
  return c.json({
    items: items.map((i) => ({ id: i.id, kind: i.kind, ext: i.ext, ...(i.orientation ? { orientation: i.orientation } : {}) })),
    leaseUntil: ts + lease,
    done: finished && !claimed,
  });
});

/**
 * Where each pass stands, and how many of today's re-runs are used: for the
 * service's `doctor`. A few rows each.
 */
stages.get('/sweeps', async (c) => {
  const ts = now();
  const { results } = await c.env.DB.prepare(`
    SELECT w.stage, w.version, w.kind, w.finished_at AS finishedAt,
           (SELECT COUNT(*) FROM media_stages s
             WHERE s.stage = w.stage AND s.version = w.version AND s.state = 'failed') AS failed
    FROM stage_sweeps w ORDER BY w.stage, w.version
  `).all();
  const used = await c.env.DB.prepare(
    'SELECT COALESCE(SUM(claimed), 0) AS n FROM stage_sweeps WHERE day = ?1'
  ).bind(Math.floor(ts / 86400)).first<{ n: number }>();
  return c.json({ sweeps: results, today: used?.n ?? 0, perDay: RERUNS_PER_DAY });
});

/**
 * What became of re-runs. A done item may bring the fields the stage
 * produced (width, height, thumbhash), and says whether it rewrote served
 * files, which bumps media.rev so their URLs change. A failed one waits a
 * growing while before it is handed out again; `permanent` gives up at once.
 */
stages.post('/report', async (c) => {
  const b = await c.req.json<{
    runner?: string;
    items?: {
      mediaId: string; stage: string; version: number; state: 'done' | 'failed';
      error?: string; permanent?: boolean;
      fields?: { width?: number; height?: number; thumbhash?: string }; rewrote?: boolean;
    }[];
  }>().catch(() => ({} as Record<string, never>));

  const items = (Array.isArray(b.items) ? b.items : []).filter((i) =>
    ID.test(i?.mediaId) && NAME.test(i?.stage) &&
    Number.isInteger(i?.version) && (i.state === 'done' || i.state === 'failed'));
  if (!items.length) return c.json({ error: 'items[] required' }, 400);
  if (items.length > 100) return c.json({ error: 'at most 100 items per call' }, 413);

  const db = c.env.DB;
  const runner = String(b.runner ?? 'unknown').slice(0, 40);
  const ts = now();
  const record = db.prepare(`
    INSERT INTO media_stages (media_id, stage, version, state, attempts, error, runner, updated_at, lease_until)
    SELECT ?1, ?2, ?3, ?4, 1, ?5, ?6, ?7, NULL WHERE EXISTS (SELECT 1 FROM media WHERE id = ?1)
    ON CONFLICT(media_id, stage) DO UPDATE SET
      state = excluded.state, error = excluded.error, runner = excluded.runner, updated_at = excluded.updated_at,
      -- A new version starts its count again; a permanent failure uses them all up.
      attempts = CASE WHEN ?8 THEN ${MAX_ATTEMPTS}
                      WHEN media_stages.version = excluded.version THEN media_stages.attempts + 1 ELSE 1 END,
      lease_until = CASE WHEN excluded.state = 'failed'
                         THEN excluded.updated_at + ${backoff('media_stages.attempts')} END,
      version = excluded.version
  `);
  const update = db.prepare(`
    UPDATE media SET width = COALESCE(?2, width), height = COALESCE(?3, height),
                     thumbhash = COALESCE(?4, thumbhash), rev = rev + ?5
    WHERE id = ?1
  `);
  const size = (n: unknown) => (Number.isInteger(n) && (n as number) > 0 && (n as number) < 100_000 ? n as number : null);

  const statements: D1PreparedStatement[] = [];
  for (const i of items) {
    statements.push(record.bind(
      i.mediaId, i.stage, i.version, i.state,
      i.state === 'failed' ? String(i.error ?? '').slice(0, 500) : null, runner, ts, i.permanent ? 1 : 0,
    ));
    if (i.state === 'done' && (i.fields || i.rewrote)) {
      const f = i.fields ?? {};
      const thumbhash = typeof f.thumbhash === 'string' && /^[A-Za-z0-9+/=]{1,100}$/.test(f.thumbhash) ? f.thumbhash : null;
      statements.push(update.bind(i.mediaId, size(f.width), size(f.height), thumbhash, i.rewrote ? 1 : 0));
    }
  }
  await db.batch(statements);
  return c.json({ ok: true, reported: items.length });
});
