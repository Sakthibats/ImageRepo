import { Hono } from 'hono';
import type { Env } from './types.js';
import type { MediaRecord } from '@imagerepo/shared';
import { requireAdmin } from './auth.js';
import { upsertAlbums, ensureAlbumRows, insertMedia, listAlbums } from './db.js';
import { bakeAlbum, bakeIndex } from './manifest.js';

const MAX_RECORDS_PER_CALL = 500;

export const admin = new Hono<{ Bindings: Env }>();
admin.use('*', requireAdmin());

admin.get('/health', async (c) => {
  // Prove both bindings actually work, not just that the Worker is up.
  const db = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM media').first<{ n: number }>();
  return c.json({ ok: true, media: db?.n ?? 0, time: Date.now() });
});

admin.post('/albums/ensure', async (c) => {
  const body = await c.req.json<{ albums: { id: string; title: string; seededFrom?: string }[] }>();
  if (!Array.isArray(body?.albums)) return c.json({ error: 'albums[] required' }, 400);

  const n = await upsertAlbums(c.env.DB, body.albums);
  return c.json({ ok: true, albums: n });
});

admin.post('/ingest', async (c) => {
  const body = await c.req.json<{ records: MediaRecord[] }>();
  if (!Array.isArray(body?.records)) return c.json({ error: 'records[] required' }, 400);
  if (body.records.length > MAX_RECORDS_PER_CALL) {
    return c.json({ error: `at most ${MAX_RECORDS_PER_CALL} records per call` }, 413);
  }

  // Referencing a missing album would fail the whole batch, so make sure every
  // album named by these records exists first.
  const albumIds = [...new Set(body.records.flatMap((r) => r.albums))];
  await ensureAlbumRows(c.env.DB, albumIds);

  const n = await insertMedia(c.env.DB, body.records);
  return c.json({ ok: true, recorded: n });
});

admin.post('/bake', async (c) => {
  const body = await c.req.json<{ album?: string }>().catch(() => ({} as { album?: string }));
  const baked: { album: string; ver: string; count: number }[] = [];

  if (body.album) {
    const r = await bakeAlbum(c.env.DB, c.env.BUCKET, body.album);
    baked.push({ album: body.album, ...r });
  } else {
    const { results } = await listAlbums(c.env.DB);
    for (const a of results as any[]) {
      const r = await bakeAlbum(c.env.DB, c.env.BUCKET, a.id);
      baked.push({ album: a.id, ...r });
    }
  }
  const albums = await bakeIndex(c.env.DB, c.env.BUCKET);
  return c.json({ ok: true, baked, albums });
});

admin.get('/albums', async (c) => {
  const { results } = await listAlbums(c.env.DB);
  return c.json({ albums: results });
});

/** Diff R2 against D1 — catches uploads whose metadata post never landed. */
admin.get('/reconcile', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id, ext, kind FROM media').all<
    { id: string; ext: string; kind: string }
  >();
  const known = new Set(results.map((r) => r.id));

  let cursor: string | undefined;
  let objects = 0;
  const orphans: string[] = [];
  do {
    const page = await c.env.BUCKET.list({ prefix: 'orig/', cursor, limit: 1000 });
    for (const o of page.objects) {
      objects++;
      const id = o.key.slice(5).split('.')[0];
      if (!known.has(id) && orphans.length < 100) orphans.push(o.key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return c.json({
    inDatabase: known.size,
    originalsInR2: objects,
    orphanedObjects: orphans.length,
    sample: orphans.slice(0, 20),
  });
});
