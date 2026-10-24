import { Hono } from 'hono';
import type { Env } from './types.js';

/**
 * Processing-stage bookkeeping. The Worker does no processing itself: runners
 * (the processing service) do the work and report here, so that D1 can answer "which
 * media still need stage X at version N?" for whichever runner asks next.
 */
export const stages = new Hono<{ Bindings: Env }>({ strict: false });

const NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const now = () => Math.floor(Date.now() / 1000);

/**
 * After this many failures an item stops being handed out. It stays in the
 * table as 'failed' with its last error — the dead-letter list — until someone
 * looks at it; bumping the stage version makes it eligible again.
 */
const MAX_ATTEMPTS = 5;

/**
 * True for a media_stages row `s` that should keep an item OUT of the backlog
 * for (stage ?1, version ?2) at time ?3: finished, held by a live lease, or
 * given up on.
 */
const SETTLED = `(
  (s.state = 'done' AND s.version >= ?2)
  OR (s.state = 'claimed' AND s.version = ?2 AND s.lease_until > ?3)
  OR (s.state = 'failed' AND s.version = ?2 AND s.attempts >= ${MAX_ATTEMPTS})
)`;

/** How far along each stage is across the library. */
stages.get('/summary', async (c) => {
  const total = await c.env.DB.prepare(
    'SELECT kind, COUNT(*) AS n FROM media GROUP BY kind'
  ).all<{ kind: string; n: number }>();
  const { results } = await c.env.DB.prepare(`
    SELECT stage, version, state, COUNT(*) AS n
    FROM media_stages GROUP BY stage, version, state
    ORDER BY stage, version
  `).all();
  return c.json({ media: total.results, stages: results });
});

/**
 * Media still waiting on `stage` at `version` — the backlog. Read-only: use
 * /claim to take work. Cursor-paginated by id so a long listing never re-reads
 * what it has already seen.
 */
stages.get('/pending', async (c) => {
  const stage = c.req.query('stage') ?? '';
  const version = Number(c.req.query('version') ?? 1);
  if (!NAME.test(stage) || !Number.isInteger(version)) {
    return c.json({ error: 'stage and integer version required' }, 400);
  }
  const kind = c.req.query('kind');
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 200), 1), 500);
  const after = c.req.query('after') ?? '';

  const { results } = await c.env.DB.prepare(`
    SELECT m.id, m.kind, m.ext, m.drv_ext
    FROM media m
    LEFT JOIN media_stages s ON s.media_id = m.id AND s.stage = ?1
    WHERE (s.media_id IS NULL OR NOT ${SETTLED})
      AND m.id > ?4 AND (?5 IS NULL OR m.kind = ?5)
    ORDER BY m.id LIMIT ?6
  `).bind(stage, version, now(), after, kind ?? null, limit).all<{ id: string }>();

  return c.json({
    items: results,
    next: results.length === limit ? results[results.length - 1].id : null,
  });
});

/**
 * Takes a batch of the backlog for one runner. The claim is a single
 * statement, so two runners asking at once can never be handed the same item.
 * A claim is a lease, not a lock: a runner that crashes just lets it lapse.
 */
stages.post('/claim', async (c) => {
  const b = await c.req.json<{
    stage?: string; version?: number; kind?: string; limit?: number;
    runner?: string; leaseSeconds?: number;
  }>().catch(() => ({} as Record<string, never>));

  const stage = b.stage ?? '';
  const version = b.version ?? 1;
  if (!NAME.test(stage) || !Number.isInteger(version)) {
    return c.json({ error: 'stage and integer version required' }, 400);
  }
  const limit = Math.min(Math.max(Number(b.limit ?? 20), 1), 200);
  const lease = Math.min(Math.max(Number(b.leaseSeconds ?? 900), 1), 6 * 3600);
  const runner = String(b.runner ?? 'unknown').slice(0, 40);
  const ts = now();

  // attempts is carried over, so repeated claim-and-crash still counts toward
  // MAX_ATTEMPTS once the failures are reported.
  const claimed = await c.env.DB.prepare(`
    INSERT INTO media_stages (media_id, stage, version, state, attempts, error, runner, updated_at, lease_until)
    SELECT m.id, ?1, ?2, 'claimed', COALESCE(s.attempts, 0), NULL, ?6, ?3, ?7
    FROM media m
    LEFT JOIN media_stages s ON s.media_id = m.id AND s.stage = ?1
    WHERE (s.media_id IS NULL OR NOT ${SETTLED})
      AND (?4 IS NULL OR m.kind = ?4)
    ORDER BY m.id LIMIT ?5
    ON CONFLICT(media_id, stage) DO UPDATE SET
      version = excluded.version, state = 'claimed', runner = excluded.runner,
      attempts = CASE WHEN media_stages.version = excluded.version THEN media_stages.attempts ELSE 0 END,
      lease_until = excluded.lease_until, updated_at = excluded.updated_at
    RETURNING media_id
  `).bind(stage, version, ts, b.kind ?? null, limit, runner, ts + lease).all<{ media_id: string }>();

  const ids = claimed.results.map((r) => r.media_id);
  if (!ids.length) return c.json({ items: [], leaseUntil: null });

  const { results } = await c.env.DB.prepare(
    `SELECT id, kind, ext, drv_ext FROM media WHERE id IN (${ids.map((_, i) => `?${i + 1}`).join(',')}) ORDER BY id`
  ).bind(...ids).all();
  return c.json({ items: results, leaseUntil: ts + lease });
});

/** Items that failed, newest first. Those at MAX_ATTEMPTS are the dead letters. */
stages.get('/failed', async (c) => {
  const stage = c.req.query('stage');
  const { results } = await c.env.DB.prepare(`
    SELECT media_id, stage, version, attempts, error, runner, updated_at,
           attempts >= ${MAX_ATTEMPTS} AS gave_up
    FROM media_stages
    WHERE state = 'failed' AND (?1 IS NULL OR stage = ?1)
    ORDER BY updated_at DESC LIMIT 200
  `).bind(stage ?? null).all();
  return c.json({ maxAttempts: MAX_ATTEMPTS, items: results });
});

/** A runner reporting the outcome of stages it ran on media that already exist. */
stages.post('/report', async (c) => {
  const b = await c.req.json<{
    runner?: string;
    items?: { mediaId: string; stage: string; version: number; state: 'done' | 'failed'; error?: string }[];
  }>().catch(() => ({} as Record<string, never>));

  const items = (b.items ?? []).filter((i) =>
    /^[0-9a-f]{32}$/.test(i?.mediaId) && NAME.test(i?.stage) &&
    Number.isInteger(i?.version) && (i.state === 'done' || i.state === 'failed'));
  if (!items.length) return c.json({ error: 'items[] required' }, 400);
  if (items.length > 500) return c.json({ error: 'at most 500 items per call' }, 413);

  const stmt = c.env.DB.prepare(`
    INSERT INTO media_stages (media_id, stage, version, state, attempts, error, runner, updated_at)
    SELECT ?1, ?2, ?3, ?4, 1, ?5, ?6, ?7 WHERE EXISTS (SELECT 1 FROM media WHERE id = ?1)
    ON CONFLICT(media_id, stage) DO UPDATE SET
      state = excluded.state, error = excluded.error, lease_until = NULL,
      runner = excluded.runner, updated_at = excluded.updated_at,
      -- A new version starts its count again.
      attempts = CASE WHEN media_stages.version = excluded.version
                      THEN media_stages.attempts + 1 ELSE 1 END,
      version = excluded.version
  `);
  const runner = String(b.runner ?? 'unknown').slice(0, 40);
  const ts = now();
  await c.env.DB.batch(items.map((i) => stmt.bind(
    i.mediaId, i.stage, i.version, i.state,
    i.state === 'failed' ? String(i.error ?? '').slice(0, 500) : null, runner, ts,
  )));
  return c.json({ ok: true, reported: items.length });
});
