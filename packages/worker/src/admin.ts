import { Hono } from 'hono';
import type { Env } from './types.js';
import type { MediaRecord } from '@imagerepo/shared';
import { requireAdmin } from './auth.js';
import { upsertAlbums, ensureAlbumRows, insertMedia, listAlbums } from './db.js';
import { bakeAlbum, bakeIndex } from './manifest.js';
import { mutations } from './mutations.js';
import { upload } from './upload.js';
import { tagWrites } from './tags.js';
import { stages } from './stages.js';

const MAX_RECORDS_PER_CALL = 500;

export const admin = new Hono<{ Bindings: Env }>({ strict: false });
admin.use('*', requireAdmin());

// Owner-only mutations (albums, media, deletes).
admin.route('/', mutations);
admin.route('/upload', upload);
admin.route('/tags', tagWrites);
admin.route('/stages', stages);

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

// ------------------------------------------------------------------- shares
import { newShareToken, sha256Hex, hashPasscode } from './share.js';

/**
 * Mints a share link. The plaintext token is returned exactly once and never
 * stored — only its sha256. If it is lost, revoke and issue another.
 */
admin.post('/shares', async (c) => {
  const body = await c.req.json<{
    albumId?: string; label?: string; expiresInDays?: number;
    passcode?: string; allowDownload?: boolean;
  }>().catch(() => ({} as Record<string, never>));

  if (!body.albumId) return c.json({ error: 'albumId required' }, 400);

  const album = await c.env.DB.prepare('SELECT id FROM albums WHERE id = ?1')
    .bind(body.albumId).first();
  if (!album) return c.json({ error: `no such album: ${body.albumId}` }, 404);

  const token = newShareToken();
  const tokenHash = await sha256Hex(token);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = body.expiresInDays ? now + Math.round(body.expiresInDays * 86400) : null;

  let pcHash: string | null = null;
  let pcSalt: string | null = null;
  if (body.passcode) {
    const h = await hashPasscode(body.passcode);
    pcHash = h.hash;
    pcSalt = h.salt;
  }

  await c.env.DB.prepare(`
    INSERT INTO share_links
      (token_hash, album_id, label, created_at, expires_at,
       passcode_hash, passcode_salt, allow_download, revoked, view_count)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, 0)
  `).bind(
    tokenHash, body.albumId, body.label ?? null, now, expiresAt,
    pcHash, pcSalt, body.allowDownload === false ? 0 : 1,
  ).run();

  const origin = new URL(c.req.url).origin;
  return c.json({
    ok: true,
    url: `${origin}/s/${token}`,
    token,                        // shown once
    tokenHash,                    // the handle used to revoke
    albumId: body.albumId,
    expiresAt,
    hasPasscode: Boolean(pcHash),
    allowDownload: body.allowDownload !== false,
  });
});

admin.get('/shares', async (c) => {
  const { results } = await c.env.DB.prepare(`
    SELECT s.token_hash, s.album_id, a.title, s.label, s.created_at, s.expires_at,
           s.allow_download, s.revoked, s.view_count, s.last_seen_at,
           CASE WHEN s.passcode_hash IS NULL THEN 0 ELSE 1 END AS has_passcode
    FROM share_links s LEFT JOIN albums a ON a.id = s.album_id
    ORDER BY s.created_at DESC
  `).all();
  return c.json({ shares: results });
});

admin.post('/shares/:tokenHash/revoke', async (c) => {
  const hash = c.req.param('tokenHash');
  const r = await c.env.DB.prepare(
    `UPDATE share_links SET revoked = 1 WHERE token_hash = ?1`
  ).bind(hash).run();
  if (!r.meta.changes) return c.json({ error: 'no such share' }, 404);
  return c.json({ ok: true, revoked: hash });
});
