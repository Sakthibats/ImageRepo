import { Hono } from 'hono';
import type { Env } from './types.js';
import { PHOTO_WIDTHS } from '@imagerepo/shared';
import { bakeAlbum, bakeIndex, deleteKeys, pruneManifests } from './manifest.js';

/**
 * Owner-only mutations. Mounted under /admin, which requireAdmin() guards, so
 * nothing here is reachable by a share-link guest — guests only ever touch
 * /s/*, which has no mutation routes at all.
 *
 * Every write that changes what an album contains re-bakes that album's
 * manifests, so the static read path never goes stale.
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

/** Albums holding any of these media. */
async function albumsOf(env: Env, ids: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const part of chunks(ids)) {
    const { results } = await env.DB.prepare(
      `SELECT DISTINCT album_id FROM album_media WHERE media_id IN (${marks(part.length)})`
    ).bind(...part).all<{ album_id: string }>();
    out.push(...results.map((r) => r.album_id));
  }
  return out;
}

/** Parses a JSON body, treating a malformed one as empty rather than a 500. */
async function body<T extends object>(c: { req: { json: <U>() => Promise<U> } }): Promise<Partial<T>> {
  return c.req.json<Partial<T>>().catch(() => ({} as Partial<T>));
}

async function rebake(env: Env, albumIds: string[]) {
  for (const id of [...new Set(albumIds)]) {
    // An album deleted in this same request has nothing to bake.
    const exists = await env.DB.prepare('SELECT 1 FROM albums WHERE id = ?1').bind(id).first();
    if (exists) await bakeAlbum(env.DB, env.BUCKET, id);
  }
  await bakeIndex(env.DB, env.BUCKET);
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

  await rebake(c.env, [id]);
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

  await rebake(c.env, [id]);
  return c.json({ ok: true });
});

/**
 * Deletes an album. By default the media survive — they may live in other
 * albums, and an accidental album delete should not destroy photos.
 */
mutations.delete('/albums/:id', async (c) => {
  const id = c.req.param('id');
  const alsoMedia = c.req.query('media') === 'delete';

  const album = await c.env.DB.prepare('SELECT id FROM albums WHERE id = ?1').bind(id).first();
  if (!album) return c.json({ error: 'no such album' }, 404);

  let removedMedia = 0;
  if (alsoMedia) {
    // Only media that exist in no OTHER album.
    const { results } = await c.env.DB.prepare(`
      SELECT media_id FROM album_media WHERE album_id = ?1
        AND media_id NOT IN (SELECT media_id FROM album_media WHERE album_id <> ?1)
    `).bind(id).all<{ media_id: string }>();
    removedMedia = await deleteMediaRows(c.env, results.map((r) => r.media_id));
  }

  await c.env.DB.prepare('DELETE FROM albums WHERE id = ?1').bind(id).run();
  // share_links and album_media cascade via the schema's foreign keys.
  await pruneManifests(c.env.BUCKET, id);
  await bakeIndex(c.env.DB, c.env.BUCKET);
  return c.json({ ok: true, deletedAlbum: id, deletedMedia: removedMedia });
});

// ----------------------------------------------------------------- folders
// One level inside an album. A folder is only a label on album_media rows,
// so creating, renaming and filling one touches D1 and the baked manifest;
// no object in R2 moves.

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

/** The album's folders with counts, for the share dialog. */
mutations.get('/albums/:id/folders', async (c) => {
  const { results } = await c.env.DB.prepare(`
    SELECT f.id, f.title, COUNT(am.media_id) AS n
    FROM folders f LEFT JOIN album_media am ON am.folder_id = f.id AND am.album_id = f.album_id
    WHERE f.album_id = ?1
    GROUP BY f.id ORDER BY f.title
  `).bind(c.req.param('id')).all();
  const loose = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM album_media WHERE album_id = ?1 AND folder_id IS NULL'
  ).bind(c.req.param('id')).first<{ n: number }>();
  return c.json({ folders: results, loose: loose?.n ?? 0 });
});

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
  await rebake(c.env, [albumId]);
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
  await rebake(c.env, [albumId]);
  return c.json({ ok: true });
});

/** Deletes a folder. Its photos stay in the album, loose. */
mutations.delete('/albums/:id/folders/:fid', async (c) => {
  const albumId = c.req.param('id');
  const folder = await folderOf(c.env, albumId, c.req.param('fid'));
  if (!folder) return c.json({ error: 'no such folder' }, 404);
  // album_media.folder_id is ON DELETE SET NULL.
  await c.env.DB.prepare('DELETE FROM folders WHERE id = ?1').bind(folder.id).run();
  await rebake(c.env, [albumId]);
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

  await rebake(c.env, [albumId]);
  return c.json({ ok: true, moved, folderId });
});

// ------------------------------------------------------------------- media

mutations.post('/albums/:id/media', async (c) => {
  const albumId = c.req.param('id');
  const b = await body<{ mediaIds?: string[]; mode?: 'add' | 'move'; fromAlbum?: string }>(c);
  const ids = (b.mediaIds ?? []).filter((x) => /^[0-9a-f]{32}$/.test(x));
  if (!ids.length) return c.json({ error: 'mediaIds required' }, 400);

  const album = await c.env.DB.prepare('SELECT id FROM albums WHERE id = ?1').bind(albumId).first();
  if (!album) return c.json({ error: 'no such album' }, 404);

  const add = c.env.DB.prepare(`
    INSERT INTO album_media (album_id, media_id, position)
    SELECT ?1, ?2, COALESCE((SELECT taken_at FROM media WHERE id = ?2), 0)
    WHERE EXISTS (SELECT 1 FROM media WHERE id = ?2)
    ON CONFLICT(album_id, media_id) DO NOTHING
  `);
  await c.env.DB.batch(ids.map((mid) => add.bind(albumId, mid)));

  const touched = [albumId];
  if (b.mode === 'move' && b.fromAlbum && b.fromAlbum !== albumId) {
    const del = c.env.DB.prepare('DELETE FROM album_media WHERE album_id = ?1 AND media_id = ?2');
    await c.env.DB.batch(ids.map((mid) => del.bind(b.fromAlbum!, mid)));
    touched.push(b.fromAlbum);
  }

  await rebake(c.env, touched);
  return c.json({ ok: true, count: ids.length, mode: b.mode ?? 'add' });
});

/** Removes media from one album. The files and other memberships are untouched. */
mutations.delete('/albums/:id/media', async (c) => {
  const albumId = c.req.param('id');
  const b = await body<{ mediaIds?: string[] }>(c);
  const ids = (b.mediaIds ?? []).filter((x) => /^[0-9a-f]{32}$/.test(x));
  if (!ids.length) return c.json({ error: 'mediaIds required' }, 400);

  const del = c.env.DB.prepare('DELETE FROM album_media WHERE album_id = ?1 AND media_id = ?2');
  await c.env.DB.batch(ids.map((mid) => del.bind(albumId, mid)));
  await rebake(c.env, [albumId]);
  return c.json({ ok: true, removed: ids.length });
});

mutations.patch('/media/:id', async (c) => {
  const id = c.req.param('id');
  const b = await body<{ caption?: string }>(c);
  const r = await c.env.DB.prepare(
    'UPDATE media SET caption = ?2 WHERE id = ?1'
  ).bind(id, b.caption?.slice(0, 500) ?? null).run();
  if (!r.meta.changes) return c.json({ error: 'no such media' }, 404);

  const { results } = await c.env.DB.prepare(
    'SELECT album_id FROM album_media WHERE media_id = ?1'
  ).bind(id).all<{ album_id: string }>();
  await rebake(c.env, results.map((r) => r.album_id));
  return c.json({ ok: true });
});

/** Permanently deletes media: every R2 object, then the D1 rows. */
mutations.delete('/media', async (c) => {
  const b = await body<{ mediaIds?: string[] }>(c);
  const ids = (b.mediaIds ?? []).filter((x) => /^[0-9a-f]{32}$/.test(x));
  if (!ids.length) return c.json({ error: 'mediaIds required' }, 400);

  const albums = await albumsOf(c.env, ids);
  const deleted = await deleteMediaRows(c.env, ids);
  await rebake(c.env, albums);
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
