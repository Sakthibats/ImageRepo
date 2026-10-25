import { Hono } from 'hono';
import type { Env } from './types.js';
import {
  lookupShare, verifyPasscode, signSession, verifySession, assetTagger, verifyAssetTag,
  IN_SCOPE, type ShareRow,
} from './share.js';
import { folderSummaries, listMedia, PAGE_MAX } from './listing.js';
import { getAsset, parseRange, type AssetRow } from './assets.js';

/**
 * Guest routes. These must be reachable WITHOUT Cloudflare Access, so the
 * hostname needs a path-scoped Access application with a Bypass policy on /s.
 *
 * Nothing here trusts the client beyond the share token and the HMAC tags the
 * server itself issued. Guests cannot enumerate: every asset request proves
 * the media id was handed to this link, and D1 confirms it is still within
 * the folders the link shares.
 */
export const guest = new Hono<{ Bindings: Env }>({ strict: false });

const SESSION_TTL = 12 * 3600;
const COOKIE = 'ir_share';

const noStore = { 'cache-control': 'no-store' };

/** What the viewer needs to render the album. No coordinates, ever. */
guest.post('/:token/session', async (c) => {
  const token = c.req.param('token');
  const share = await lookupShare(c.env.DB, token);
  if (!share) return c.json({ error: 'invalid or expired link' }, 404, noStore);

  if (share.passcode_hash && share.passcode_salt) {
    const body = await c.req.json<{ passcode?: string }>()
      .catch(() => ({} as { passcode?: string }));
    if (!body.passcode) return c.json({ needPasscode: true }, 401, noStore);
    const ok = await verifyPasscode(body.passcode, share.passcode_hash, share.passcode_salt);
    if (!ok) return c.json({ needPasscode: true, error: 'wrong passcode' }, 401, noStore);
  }

  const session = {
    s: share.token_hash.slice(0, 16),
    a: share.album_id,
    d: share.allow_download === 1,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL,
  };
  const cookie = await signSession(c.env, session);

  // Fire-and-forget: a view counter must never delay the response.
  c.executionCtx.waitUntil(
    c.env.DB.prepare(
      `UPDATE share_links SET view_count = view_count + 1, last_seen_at = ?1 WHERE token_hash = ?2`
    ).bind(Math.floor(Date.now() / 1000), share.token_hash).run(),
  );

  const payload = await guestAlbum(c.env, share, session.s);

  c.header('set-cookie',
    `${COOKIE}=${cookie}; Path=/s/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL}`);
  return c.json({ ...payload, allowDownload: session.d }, 200, noStore);
});

/**
 * What the viewer needs before the photos: the album's name, how many items
 * the link shows, and its folders. Counts come from rows, not from counting
 * photos. No coordinates, ever.
 */
async function guestAlbum(env: Env, share: ShareRow, shareId: string) {
  const album = await env.DB.prepare(`
    SELECT a.id, a.title, a.item_count AS n,
           (SELECT COALESCE(SUM(item_count), 0) FROM folders WHERE album_id = a.id) AS filed
    FROM albums a WHERE a.id = ?1
  `).bind(share.album_id).first<{ id: string; title: string; n: number; filed: number }>();
  const n = album?.n ?? 0;
  const loose = n - (album?.filed ?? 0);

  // Names of folders outside the link are never sent, and nor are empty ones.
  const folders = await folderSummaries(env.DB, { share: share.token_hash });
  const showsLoose = share.scope === 'all' || share.include_loose === 1;
  const count = share.scope === 'all' ? n
    : folders.reduce((sum, f) => sum + f.n, 0) + (showsLoose ? loose : 0);

  // A cover may not be on the pages loaded yet, so it comes with its own tag.
  const tag = await assetTagger(env, shareId);
  for (const f of folders) if (f.cover) f.coverTag = await tag(f.cover);

  return {
    album: share.album_id, title: album?.title ?? share.album_id,
    count, loose: showsLoose ? loose : 0, folders,
  };
}

/**
 * A page of what the link shows, oldest first unless `order=desc`, each item
 * with the tag that lets this guest load it. Needs the session cookie, so a
 * passcode protects the photos and not only the first screen.
 */
guest.get('/:token/media', async (c) => {
  const share = await lookupShare(c.env.DB, c.req.param('token'));
  if (!share) return c.json({ error: 'invalid or expired link' }, 404, noStore);
  const cookie = new RegExp(`${COOKIE}=([^;]+)`).exec(c.req.header('cookie') ?? '')?.[1];
  const session = cookie ? await verifySession(c.env, cookie) : null;
  if (!session || session.s !== share.token_hash.slice(0, 16)) return c.json({ error: 'no session' }, 401, noStore);

  const page = await listMedia(c.env.DB, { by: 'share', tokenHash: share.token_hash }, 'guest', {
    order: c.req.query('order') === 'desc' ? 'desc' : 'asc',
    after: c.req.query('after'), limit: Number(c.req.query('limit')) || PAGE_MAX,
  });
  const tag = await assetTagger(c.env, session.s);
  const items = await Promise.all(page.items.map(async (i) => ({ ...i, t2: await tag(i.id) })));
  return c.json({ items, next: page.next }, 200, noStore);
});

/** Serves one asset to a guest. */
guest.get('/:token/a/:id/:variant', async (c) => {
  const cookie = /ir_share=([^;]+)/.exec(c.req.header('cookie') ?? '')?.[1];
  const session = cookie ? await verifySession(c.env, cookie) : null;
  if (!session) return c.json({ error: 'no session' }, 401, noStore);

  const id = c.req.param('id');
  const variant = c.req.param('variant');
  const tag = c.req.query('t') ?? '';

  if (!/^[0-9a-f]{32}$/.test(id)) return c.json({ error: 'bad id' }, 400, noStore);
  if (!['320', '1024', '2048', 'poster', 'preview', 'orig'].includes(variant)) {
    return c.json({ error: 'bad variant' }, 400, noStore);
  }
  if (variant === 'orig' && !session.d) {
    return c.json({ error: 'downloads disabled for this link' }, 403, noStore);
  }

  // The tag is what proves this media id belongs to the shared album. Without
  // it, a guest holding any id could read the whole library.
  if (!(await verifyAssetTag(c.env, session.s, id, tag))) {
    return c.json({ error: 'not authorised for this item' }, 403, noStore);
  }

  // The tag proves the item was handed out; this proves the link still shares
  // it. Revoking a link or taking a folder out of it applies here at once.
  const row = await c.env.DB.prepare(`
    SELECT m.id, m.kind, m.ext, m.drv_ext, m.width, m.orig_name
    FROM share_links s
    JOIN album_media am ON am.album_id = s.album_id AND am.media_id = ?1
    JOIN media m ON m.id = am.media_id
    WHERE substr(s.token_hash, 1, 16) = ?2 AND s.album_id = ?3
      AND s.revoked = 0 AND (s.expires_at IS NULL OR s.expires_at > ?4)
      AND ${IN_SCOPE}
    LIMIT 1
  `).bind(id, session.s, session.a, Math.floor(Date.now() / 1000))
    .first<AssetRow & { orig_name: string | null }>();
  if (!row) return c.json({ error: 'not authorised for this item' }, 403, noStore);

  const rangeHeader = c.req.header('range');
  const range = rangeHeader ? parseRange(rangeHeader) : undefined;
  const found = await getAsset(c.env.BUCKET, row, variant, range);
  if (!found) return c.json({ error: 'object missing' }, 404, noStore);
  const { obj, type } = found;

  const headers = new Headers();
  headers.set('content-type', type);
  // Cacheable, but only within the tag's bucket window.
  headers.set('cache-control', 'public, max-age=3600');
  headers.set('etag', obj.httpEtag);
  headers.set('accept-ranges', 'bytes');
  headers.set('x-content-type-options', 'nosniff');

  if (variant === 'orig') {
    const name = (row.orig_name ?? '').replace(/[\\"\r\n\x00-\x1f]/g, '').replace(/[/]/g, '_')
      || `${row.id}.${row.ext}`;
    headers.set('content-disposition', `attachment; filename="${name}"`);
  }

  if (range && obj.range && 'offset' in obj.range) {
    const start = obj.range.offset ?? 0;
    const len = obj.range.length ?? obj.size - start;
    headers.set('content-range', `bytes ${start}-${start + len - 1}/${obj.size}`);
    headers.set('content-length', String(len));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set('content-length', String(obj.size));
  return new Response(obj.body, { status: 200, headers });
});

/**
 * Serves the app shell for a share link. run_worker_first routes /s/* here, so
 * the static-asset SPA fallback never sees these paths — we hand back
 * index.html explicitly and let the client read the token from the URL.
 *
 * The token is NOT validated here: doing so would leak link validity to anyone
 * probing, and the session endpoint is the real gate anyway.
 */
guest.get('/:token', async (c) => {
  const res = await c.env.ASSETS.fetch(new URL('/index.html', c.req.url));
  return new Response(res.body, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      // A shared album should never end up in a search index.
      'x-robots-tag': 'noindex, nofollow',
    },
  });
});
