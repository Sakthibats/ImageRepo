import { Hono } from 'hono';
import type { Env } from './types.js';
import { PHOTO_WIDTHS } from '@imagerepo/shared';

/**
 * Owner-only mutations. Mounted under /admin, which requireAdmin() guards, so
 * nothing here is reachable by a share-link guest — guests only ever touch
 * /s/*, which has no mutation routes at all.
 *
 * Writes touch D1 only: every read is live, and the counts and sort dates
 * listings use are kept by triggers (migration 011).
 */
export const mutations = new Hono<{ Bindings: Env }>({ strict: false });

const slug = (s: string) =>
  s.normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);

const now = () => Math.floor(Date.now() / 1000);

/**
 * D1 caps a statement at 100 bound parameters, and a request at a limited
 * number of queries, so lists of ids are handled in IN (...) chunks rather
 * than one statement per id.
 */
const CHUNK = 90;
const chunks = <T>(xs: T[], n = CHUNK): T[][] =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const marks = (n: number) => Array.from({ length: n }, (_, i) => `?${i + 1}`).join(',');

/** Parses a JSON body, treating a malformed one as empty rather than a 500. */
async function body<T extends object>(c: { req: { json: <U>() => Promise<U> } }): Promise<Partial<T>> {
  return c.req.json<Partial<T>>().catch(() => ({} as Partial<T>));
}

// ------------------------------------------------------------------ albums

mutations.post('/albums', async (c) => {
  const b = await body<{ title?: string; id?: string }>(c);
  const title = (b.title ?? '').trim();
  if (!title) return c.json({ error: 'title required' }, 400);

  const id = slug(b.id ?? title) || `album-${Date.now()}`;

  // Reject on either the slug or the visible title. Two albums with different
  // ids but the same name are indistinguishable in the UI, which is how people
  // end up with two "Holidays" and photos split across both.
  const clash = await c.env.DB.prepare(
    'SELECT id, title FROM albums WHERE id = ?1 OR LOWER(title) = LOWER(?2) LIMIT 1'
  ).bind(id, title).first<{ id: string; title: string }>();
  if (clash) {
    return c.json({ error: `an album named "${clash.title}" already exists` }, 409);
  }

  await c.env.DB.prepare(
    `INSERT INTO albums (id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)`
  ).bind(id, title, now()).run();
  return c.json({ ok: true, id, title });
});

mutations.patch('/albums/:id', async (c) => {
  const id = c.req.param('id');
  const b = await body<{ title?: string; description?: string; coverId?: string }>(c);

  const album = await c.env.DB.prepare('SELECT id FROM albums WHERE id = ?1').bind(id).first();
  if (!album) return c.json({ error: 'no such album' }, 404);

  const title = b.title?.trim() || null;
  if (title) {
    // Same rule as creation: two albums with one visible name are
    // indistinguishable in the UI.
    const clash = await c.env.DB.prepare(
      'SELECT title FROM albums WHERE LOWER(title) = LOWER(?1) AND id <> ?2 LIMIT 1'
    ).bind(title, id).first<{ title: string }>();
    if (clash) {
      return c.json({ error: `an album named "${clash.title}" already exists` }, 409);
    }
  }

  if (b.coverId) {
    // A cover must actually be in the album, or the album list shows a photo
    // that is not there.
    const inAlbum = await c.env.DB.prepare(
      'SELECT 1 FROM album_media WHERE album_id = ?1 AND media_id = ?2'
    ).bind(id, b.coverId).first();
    if (!inAlbum) return c.json({ error: 'cover must be a photo in this album' }, 400);
  }

  await c.env.DB.prepare(`
    UPDATE albums SET
      title       = COALESCE(?2, title),
      description = COALESCE(?3, description),
      cover_id    = COALESCE(?4, cover_id),
      updated_at  = ?5
    WHERE id = ?1
  `).bind(id, title, b.description ?? null, b.coverId ?? null, now()).run();
  return c.json({ ok: true });
});

/**
 * Deletes an album. By default the media survive, in no album, so an
 * accidental album delete does not destroy photos.
 */
mutations.delete('/albums/:id', async (c) => {
  const id = c.req.param('id');
  const alsoMedia = c.req.query('media') === 'delete';

  const album = await c.env.DB.prepare('SELECT id FROM albums WHERE id = ?1').bind(id).first();
  if (!album) return c.json({ error: 'no such album' }, 404);

  let removedMedia = 0;
  if (alsoMedia) {
    const { results } = await c.env.DB.prepare(
      'SELECT media_id FROM album_media WHERE album_id = ?1'
    ).bind(id).all<{ media_id: string }>();
    removedMedia = await deleteMediaRows(c.env, results.map((r) => r.media_id));
  }

  await c.env.DB.prepare('DELETE FROM albums WHERE id = ?1').bind(id).run();
  // share_links and album_media cascade via the schema's foreign keys.
  return c.json({ ok: true, deletedAlbum: id, deletedMedia: removedMedia });
});

// ----------------------------------------------------------------- folders
// One level inside an album. A folder is only a label on album_media rows,
// so creating, renaming and filling one touches D1 alone; no object in R2 moves.

const FOLDER_ID = /^[0-9a-f]{12}$/;
const newFolderId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12);

async function folderOf(env: Env, albumId: string, folderId: string) {
  if (!FOLDER_ID.test(folderId)) return null;
  return env.DB.prepare('SELECT id, title FROM folders WHERE id = ?1 AND album_id = ?2')
    .bind(folderId, albumId).first<{ id: string; title: string }>();
}

/** A folder title already used in this album, ignoring case. */
async function folderClash(env: Env, albumId: string, title: string, except = '') {
  return env.DB.prepare(
    'SELECT title FROM folders WHERE album_id = ?1 AND LOWER(title) = LOWER(?2) AND id <> ?3 LIMIT 1'
  ).bind(albumId, title, except).first<{ title: string }>();
}

mutations.post('/albums/:id/folders', async (c) => {
  const albumId = c.req.param('id');
  const b = await body<{ title?: string }>(c);
  const title = (b.title ?? '').trim().slice(0, 120);
  if (!title) return c.json({ error: 'title required' }, 400);

  const album = await c.env.DB.prepare('SELECT id FROM albums WHERE id = ?1').bind(albumId).first();
  if (!album) return c.json({ error: 'no such album' }, 404);
  const clash = await folderClash(c.env, albumId, title);
  if (clash) return c.json({ error: `a folder named "${clash.title}" already exists in this album` }, 409);

  const id = newFolderId();
  await c.env.DB.prepare(
    'INSERT INTO folders (id, album_id, title, created_at) VALUES (?1, ?2, ?3, ?4)'
  ).bind(id, albumId, title, now()).run();
  return c.json({ ok: true, id, title });
});

/** Rename, or set the cover. `coverId: null` goes back to the earliest photo. */
mutations.patch('/albums/:id/folders/:fid', async (c) => {
  const albumId = c.req.param('id');
  const folder = await folderOf(c.env, albumId, c.req.param('fid'));
  if (!folder) return c.json({ error: 'no such folder' }, 404);
  const b = await body<{ title?: string; coverId?: string | null }>(c);

  const title = b.title?.trim().slice(0, 120) || null;
  if (title) {
    const clash = await folderClash(c.env, albumId, title, folder.id);
    if (clash) return c.json({ error: `a folder named "${clash.title}" already exists in this album` }, 409);
  }
  if (b.coverId) {
    // Any photo in the album will do, not only the folder's own.
    const inAlbum = await c.env.DB.prepare(
      'SELECT 1 FROM album_media WHERE album_id = ?1 AND media_id = ?2'
    ).bind(albumId, b.coverId).first();
    if (!inAlbum) return c.json({ error: 'cover must be a photo in this album' }, 400);
  }

  await c.env.DB.prepare(`
    UPDATE folders SET
      title    = COALESCE(?2, title),
      cover_id = CASE WHEN ?3 = 1 THEN ?4 ELSE cover_id END
    WHERE id = ?1
  `).bind(folder.id, title, b.coverId === undefined ? 0 : 1, b.coverId ?? null).run();
  return c.json({ ok: true });
});

/** Deletes a folder. Its photos stay in the album, loose. */
mutations.delete('/albums/:id/folders/:fid', async (c) => {
  const albumId = c.req.param('id');
  const folder = await folderOf(c.env, albumId, c.req.param('fid'));
  if (!folder) return c.json({ error: 'no such folder' }, 404);
  // album_media.folder_id is ON DELETE SET NULL.
  await c.env.DB.prepare('DELETE FROM folders WHERE id = ?1').bind(folder.id).run();
  return c.json({ ok: true, deleted: folder.id });
});

/** Files photos already in the album into a folder, or back out (`folderId: null`). */
mutations.post('/albums/:id/folder-items', async (c) => {
  const albumId = c.req.param('id');
  const b = await body<{ mediaIds?: string[]; folderId?: string | null }>(c);
  const ids = (b.mediaIds ?? []).filter((x) => /^[0-9a-f]{32}$/.test(x));
  if (!ids.length) return c.json({ error: 'mediaIds required' }, 400);

  let folderId: string | null = null;
  if (b.folderId) {
    const folder = await folderOf(c.env, albumId, b.folderId);
    if (!folder) return c.json({ error: 'no such folder in this album' }, 404);
    folderId = folder.id;
  }

  // ?1 and ?2 are taken, so each chunk's ids start at ?3.
  const results = await c.env.DB.batch(chunks(ids).map((part) => c.env.DB.prepare(`
    UPDATE album_media SET folder_id = ?1
    WHERE album_id = ?2 AND media_id IN (${part.map((_, i) => `?${i + 3}`).join(',')})
  `).bind(folderId, albumId, ...part)));
  const moved = results.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
  return c.json({ ok: true, moved, folderId });
});

// ------------------------------------------------------------------- media

/**
 * Moves media into this album from whichever album holds them, or files ones
 * in no album. A photo lives in one album, and arrives loose: folders belong
 * to the album it left.
 */
mutations.post('/albums/:id/media', async (c) => {
  const albumId = c.req.param('id');
  const b = await body<{ mediaIds?: string[] }>(c);
  const ids = (b.mediaIds ?? []).filter((x) => /^[0-9a-f]{32}$/.test(x));
  if (!ids.length) return c.json({ error: 'mediaIds required' }, 400);

  const album = await c.env.DB.prepare('SELECT id FROM albums WHERE id = ?1').bind(albumId).first();
  if (!album) return c.json({ error: 'no such album' }, 404);

  const move = c.env.DB.prepare(`
    INSERT INTO album_media (album_id, media_id, sort_ts)
    SELECT ?1, id, sort_ts FROM media WHERE id = ?2
    ON CONFLICT(media_id) DO UPDATE SET album_id = excluded.album_id, folder_id = NULL
      WHERE album_id <> excluded.album_id
  `);
  await c.env.DB.batch(ids.map((mid) => move.bind(albumId, mid)));
  return c.json({ ok: true, count: ids.length });
});

/** Takes media out of their album, leaving them in none. The files are untouched. */
mutations.delete('/albums/:id/media', async (c) => {
  const albumId = c.req.param('id');
  const b = await body<{ mediaIds?: string[] }>(c);
  const ids = (b.mediaIds ?? []).filter((x) => /^[0-9a-f]{32}$/.test(x));
  if (!ids.length) return c.json({ error: 'mediaIds required' }, 400);

  const del = c.env.DB.prepare('DELETE FROM album_media WHERE album_id = ?1 AND media_id = ?2');
  await c.env.DB.batch(ids.map((mid) => del.bind(albumId, mid)));
  return c.json({ ok: true, removed: ids.length });
});

mutations.patch('/media/:id', async (c) => {
  const id = c.req.param('id');
  const b = await body<{ caption?: string }>(c);
  const r = await c.env.DB.prepare(
    'UPDATE media SET caption = ?2 WHERE id = ?1'
  ).bind(id, b.caption?.slice(0, 500) ?? null).run();
  if (!r.meta.changes) return c.json({ error: 'no such media' }, 404);
  return c.json({ ok: true });
});

/** Permanently deletes media: every R2 object, then the D1 rows. */
mutations.delete('/media', async (c) => {
  const b = await body<{ mediaIds?: string[] }>(c);
  const ids = (b.mediaIds ?? []).filter((x) => /^[0-9a-f]{32}$/.test(x));
  if (!ids.length) return c.json({ error: 'mediaIds required' }, 400);

  const deleted = await deleteMediaRows(c.env, ids);
  return c.json({ ok: true, deleted });
});

/**
 * Every object a media item can have in R2. Stage versions never change a
 * key, so this is all of them; delete is idempotent, so keys a kind of media
 * never had cost nothing.
 */
function mediaKeys(row: { id: string; kind: string; ext: string; drv_ext: string | null }): string[] {
  const dx = row.drv_ext || 'avif';
  return [
    `orig/${row.id}.${row.kind === 'video' ? 'mp4' : row.ext}`,
    `post/${row.id}.jpg`,
    `prev/${row.id}.mp4`,
    ...PHOTO_WIDTHS.map((w) => `drv/${row.id}/${w}.${dx}`),
  ];
}

/** R2 deletes at most 1000 keys per call. */
async function deleteKeys(bucket: R2Bucket, keys: string[]) {
  for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
}

/** Shared by media delete and album-delete-with-media. */
async function deleteMediaRows(env: Env, ids: string[]): Promise<number> {
  if (!ids.length) return 0;

  const keys: string[] = [];
  let found = 0;
  for (const part of chunks(ids)) {
    const { results } = await env.DB.prepare(
      `SELECT id, kind, ext, drv_ext FROM media WHERE id IN (${marks(part.length)})`
    ).bind(...part).all<{ id: string; kind: string; ext: string; drv_ext: string | null }>();
    for (const row of results) keys.push(...mediaKeys(row));
    found += results.length;
  }
  await deleteKeys(env.BUCKET, keys);

  // Tags, stages and album memberships cascade from media.
  await env.DB.batch(chunks(ids).map((part) =>
    env.DB.prepare(`DELETE FROM media WHERE id IN (${marks(part.length)})`).bind(...part)));
  return found;
}
