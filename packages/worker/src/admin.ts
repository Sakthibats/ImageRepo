import { Hono } from 'hono';
import type { Env } from './types.js';
import { requireAdmin } from './auth.js';
import { mutations } from './mutations.js';
import { inbox } from './inbox.js';
import { tagWrites } from './tags.js';
import { stages } from './stages.js';
import { purge } from './purge.js';

export const admin = new Hono<{ Bindings: Env }>({ strict: false });
admin.use('*', requireAdmin());

// Owner-only mutations (albums, media, deletes).
admin.route('/', mutations);
admin.route('/inbox', inbox);
admin.route('/tags', tagWrites);
admin.route('/stages', stages);
admin.route('/purge', purge);

admin.get('/health', async (c) => {
  // Prove both bindings actually work, not just that the Worker is up.
  const db = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM media').first<{ n: number }>();
  return c.json({ ok: true, media: db?.n ?? 0, time: Date.now() });
});

// ------------------------------------------------------------------- shares
import { newShareToken, sha256Hex, hashPasscode, readScope, writeScope } from './share.js';

/**
 * Mints a share link. The plaintext token is returned exactly once and never
 * stored — only its sha256. If it is lost, revoke and issue another.
 */
admin.post('/shares', async (c) => {
  const body = await c.req.json<{
    albumId?: string; label?: string; expiresInDays?: number;
    passcode?: string; allowDownload?: boolean;
    /** 'all' (the default) or 'folders', with folderIds and includeLoose. */
    scope?: string; folderIds?: string[]; includeLoose?: boolean;
  }>().catch(() => ({} as Record<string, never>));

  if (!body.albumId) return c.json({ error: 'albumId required' }, 400);

  const album = await c.env.DB.prepare('SELECT id FROM albums WHERE id = ?1')
    .bind(body.albumId).first();
  if (!album) return c.json({ error: `no such album: ${body.albumId}` }, 404);

  const scope = await readScope(c.env.DB, body.albumId, body);
  if ('error' in scope) return c.json({ error: scope.error }, 400);

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

  // One batch, so a link never exists for a moment showing more than it should.
  await c.env.DB.batch([
    c.env.DB.prepare(`
      INSERT INTO share_links
        (token_hash, album_id, label, created_at, expires_at,
         passcode_hash, passcode_salt, allow_download, revoked, view_count)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, 0)
    `).bind(
      tokenHash, body.albumId, body.label ?? null, now, expiresAt,
      pcHash, pcSalt, body.allowDownload === false ? 0 : 1,
    ),
    ...writeScope(c.env.DB, tokenHash, scope),
  ]);

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
    scope: scope.scope,
    folderIds: scope.folderIds,
    includeLoose: scope.includeLoose,
  });
});

/** Changes what an existing link shows. The URL stays the same. */
admin.patch('/shares/:tokenHash', async (c) => {
  const hash = c.req.param('tokenHash');
  const share = await c.env.DB.prepare('SELECT album_id FROM share_links WHERE token_hash = ?1')
    .bind(hash).first<{ album_id: string }>();
  if (!share) return c.json({ error: 'no such share' }, 404);

  const body = await c.req.json<{ scope?: string; folderIds?: string[]; includeLoose?: boolean }>()
    .catch(() => ({} as Record<string, never>));
  const scope = await readScope(c.env.DB, share.album_id, body);
  if ('error' in scope) return c.json({ error: scope.error }, 400);

  await c.env.DB.batch(writeScope(c.env.DB, hash, scope));
  return c.json({ ok: true, ...scope });
});

admin.get('/shares', async (c) => {
  const { results } = await c.env.DB.prepare(`
    SELECT s.token_hash, s.album_id, a.title, s.label, s.created_at, s.expires_at,
           s.allow_download, s.revoked, s.view_count, s.last_seen_at,
           CASE WHEN s.passcode_hash IS NULL THEN 0 ELSE 1 END AS has_passcode,
           s.scope, s.include_loose,
           (SELECT json_group_array(json_object('id', f.id, 'title', f.title))
              FROM share_folders sf JOIN folders f ON f.id = sf.folder_id
              WHERE sf.token_hash = s.token_hash) AS folders
    FROM share_links s LEFT JOIN albums a ON a.id = s.album_id
    ORDER BY s.created_at DESC
  `).all<Record<string, unknown> & { folders: string | null }>();
  return c.json({
    shares: results.map((r) => ({ ...r, folders: JSON.parse(r.folders ?? '[]') })),
  });
});

admin.post('/shares/:tokenHash/revoke', async (c) => {
  const hash = c.req.param('tokenHash');
  const r = await c.env.DB.prepare(
    `UPDATE share_links SET revoked = 1 WHERE token_hash = ?1`
  ).bind(hash).run();
  if (!r.meta.changes) return c.json({ error: 'no such share' }, 404);
  return c.json({ ok: true, revoked: hash });
});
