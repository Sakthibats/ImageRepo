import { Hono } from 'hono';
import type { Env } from './types.js';
import { bakeAlbum, bakeIndex } from './manifest.js';

/**
 * Browser upload.
 *
 * The browser sends the original plus derivatives it rendered with canvas.
 * Doing the resize client-side avoids both the Worker CPU limit (10ms on the
 * free plan, nowhere near enough to decode a 12MP JPEG) and any dependency on
 * an image-transformation service.
 *
 * Workers cap request bodies, so this path is for photos. Video and bulk
 * backfill go through the CLI, which has ffmpeg and no such ceiling.
 */
export const upload = new Hono<{ Bindings: Env }>({ strict: false });

const MAX_BYTES = 30 * 1024 * 1024;
const VARIANTS = new Set(['orig', '320', '1024', '2048']);

/** Tells the client which files it can skip re-uploading. */
upload.post('/check', async (c) => {
  const b = await c.req.json<{ ids?: string[] }>().catch(() => ({} as { ids?: string[] }));
  const ids = (b.ids ?? []).filter((x) => /^[0-9a-f]{32}$/.test(x)).slice(0, 500);
  if (!ids.length) return c.json({ known: [] });

  const { results } = await c.env.DB.prepare(
    `SELECT id FROM media WHERE id IN (${ids.map((_, i) => `?${i + 1}`).join(',')})`
  ).bind(...ids).all<{ id: string }>();
  return c.json({ known: results.map((r) => r.id) });
});

upload.put('/:id/:variant', async (c) => {
  const id = c.req.param('id');
  const variant = c.req.param('variant');
  if (!/^[0-9a-f]{32}$/.test(id)) return c.json({ error: 'bad id' }, 400);
  if (!VARIANTS.has(variant)) return c.json({ error: 'bad variant' }, 400);

  const len = Number(c.req.header('content-length') ?? 0);
  if (len > MAX_BYTES) {
    return c.json({ error: `file too large (${Math.round(len / 1048576)}MB); use the CLI` }, 413);
  }

  const drvExt = (c.req.query('ext') ?? 'webp').replace(/[^a-z0-9]/g, '');
  const body = await c.req.arrayBuffer();
  if (!body.byteLength) return c.json({ error: 'empty body' }, 400);

  const key = variant === 'orig' ? `orig/${id}.jpg` : `drv/${id}/${variant}.${drvExt}`;
  const type = variant === 'orig' ? 'image/jpeg' : `image/${drvExt}`;

  await c.env.BUCKET.put(key, body, {
    httpMetadata: { contentType: type, cacheControl: 'public, max-age=31536000, immutable' },
  });
  return c.json({ ok: true, key, bytes: body.byteLength });
});

/** Writes the D1 rows once every object for a batch is in R2. */
upload.post('/commit', async (c) => {
  const b = await c.req.json<{
    albumId?: string;
    records?: Array<{
      id: string; width: number; height: number; bytes: number;
      takenAt?: number; thumbhash?: string; origName: string;
      drvExt?: string; derivatives?: string[];
    }>;
  }>().catch(() => ({} as Record<string, never>));

  const albumId = b.albumId;
  const records = b.records ?? [];
  if (!albumId || !records.length) return c.json({ error: 'albumId and records required' }, 400);

  const album = await c.env.DB.prepare('SELECT id FROM albums WHERE id = ?1').bind(albumId).first();
  if (!album) return c.json({ error: 'no such album' }, 404);

  const ts = Math.floor(Date.now() / 1000);
  const media = c.env.DB.prepare(`
    INSERT INTO media (id, kind, ext, drv_ext, bytes, width, height, taken_at,
                       uploaded_at, thumbhash, orig_name)
    VALUES (?1, 'photo', 'jpg', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
    ON CONFLICT(id) DO UPDATE SET
      width = excluded.width, height = excluded.height, thumbhash = excluded.thumbhash
  `);
  const link = c.env.DB.prepare(`
    INSERT INTO album_media (album_id, media_id, position) VALUES (?1, ?2, ?3)
    ON CONFLICT(album_id, media_id) DO NOTHING
  `);

  const stmts = [];
  for (const r of records) {
    if (!/^[0-9a-f]{32}$/.test(r.id)) continue;
    stmts.push(media.bind(
      r.id, r.drvExt ?? 'webp', r.bytes, r.width, r.height,
      r.takenAt ?? ts, ts, r.thumbhash ?? null, r.origName ?? r.id,
    ));
    stmts.push(link.bind(albumId, r.id, r.takenAt ?? ts));
  }
  if (!stmts.length) return c.json({ error: 'no valid records' }, 400);
  await c.env.DB.batch(stmts);

  await bakeAlbum(c.env.DB, c.env.BUCKET, albumId);
  await bakeIndex(c.env.DB, c.env.BUCKET);
  return c.json({ ok: true, added: records.length });
});
