import { Hono } from 'hono';
import type { Env } from './types.js';

/**
 * Processing-stage bookkeeping. The Worker does no processing itself: runners
 * (the CLI today) do the work and report here, so that D1 can answer "which
 * media still need stage X at version N?" for whichever runner asks next.
 */
export const stages = new Hono<{ Bindings: Env }>({ strict: false });

const NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const now = () => Math.floor(Date.now() / 1000);

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
 * Media that have not completed `stage` at `version` or later — the backlog a
 * runner works through. Cursor-paginated by id so a long backfill never
 * re-reads what it has already seen.
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
    LEFT JOIN media_stages s
      ON s.media_id = m.id AND s.stage = ?1 AND s.state = 'done' AND s.version >= ?2
    WHERE s.media_id IS NULL AND m.id > ?3 AND (?4 IS NULL OR m.kind = ?4)
    ORDER BY m.id LIMIT ?5
  `).bind(stage, version, after, kind ?? null, limit).all<{ id: string }>();

  return c.json({
    items: results,
    next: results.length === limit ? results[results.length - 1].id : null,
  });
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
      version = excluded.version, state = excluded.state, error = excluded.error,
      runner = excluded.runner, updated_at = excluded.updated_at,
      attempts = media_stages.attempts + 1
  `);
  const runner = String(b.runner ?? 'unknown').slice(0, 40);
  const ts = now();
  await c.env.DB.batch(items.map((i) => stmt.bind(
    i.mediaId, i.stage, i.version, i.state,
    i.state === 'failed' ? String(i.error ?? '').slice(0, 500) : null, runner, ts,
  )));
  return c.json({ ok: true, reported: items.length });
});
