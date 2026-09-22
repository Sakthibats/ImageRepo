import { Hono } from 'hono';
import type { Env } from './types.js';
import type { ManifestItem } from '@imagerepo/shared';
import {
  lookupShare, verifyPasscode, signSession, verifySession, assetTag, verifyAssetTag,
} from './share.js';

/**
 * Guest routes. These must be reachable WITHOUT Cloudflare Access, so the
 * hostname needs a path-scoped Access application with a Bypass policy on /s.
 *
 * Nothing here trusts the client beyond the share token and the HMAC tags the
 * server itself issued. Guests cannot enumerate: every asset request proves
 * the media id was part of the album this token grants.
 */
export const guest = new Hono<{ Bindings: Env }>();

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

  const payload = await buildGuestManifest(c.env, share.album_id, session.s);

  c.header('set-cookie',
    `${COOKIE}=${cookie}; Path=/s/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL}`);
  return c.json({ ...payload, allowDownload: session.d }, 200, noStore);
});

async function buildGuestManifest(env: Env, albumId: string, shareId: string) {
  const album = await env.DB.prepare(`SELECT id, title FROM albums WHERE id = ?1`)
    .bind(albumId).first<{ id: string; title: string }>();

  const { results } = await env.DB.prepare(`
    SELECT m.id, m.kind, m.width, m.height, m.taken_at, m.thumbhash, m.duration_ms, m.caption
    FROM album_media am JOIN media m ON m.id = am.media_id
    WHERE am.album_id = ?1
    ORDER BY COALESCE(m.taken_at, 0), m.id
  `).bind(albumId).all();

  // Queried column-by-column rather than SELECT *, so lat/lon/place cannot
  // reach a guest even by accident.
  const items: (ManifestItem & { t2: string })[] = [];
  for (const r of results as any[]) {
    items.push({
      id: r.id,
      k: r.kind,
      w: r.width ?? 0,
      h: r.height ?? 0,
      ...(r.taken_at ? { t: r.taken_at } : {}),
      ...(r.thumbhash ? { th: r.thumbhash } : {}),
      ...(r.duration_ms ? { d: r.duration_ms } : {}),
      ...(r.caption ? { c: r.caption } : {}),
      t2: await assetTag(env, shareId, r.id),
    });
  }
  return { album: albumId, title: album?.title ?? albumId, count: items.length, items };
}

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

  const row = await c.env.DB
    .prepare('SELECT id, kind, ext, drv_ext, orig_name FROM media WHERE id = ?1')
    .bind(id)
    .first<{ id: string; kind: string; ext: string; drv_ext: string; orig_name: string | null }>();
  if (!row) return c.json({ error: 'not found' }, 404, noStore);

  const key = variant === 'orig'
    ? `orig/${row.id}.${row.kind === 'video' ? 'mp4' : row.ext}`
    : variant === 'poster' ? `post/${row.id}.jpg`
    : variant === 'preview' ? `prev/${row.id}.mp4`
    : `drv/${row.id}/${variant}.${row.drv_ext || 'avif'}`;

  const rangeHeader = c.req.header('range');
  const range = rangeHeader ? parseRange(rangeHeader) : undefined;
  const obj = range ? await c.env.BUCKET.get(key, { range }) : await c.env.BUCKET.get(key);
  if (!obj || !('body' in obj)) return c.json({ error: 'object missing' }, 404, noStore);

  const headers = new Headers();
  headers.set('content-type', contentTypeFor(variant, row.kind, row.drv_ext));
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

function contentTypeFor(variant: string, kind: string, drvExt = 'avif'): string {
  if (variant === 'orig') return kind === 'video' ? 'video/mp4' : 'image/jpeg';
  if (variant === 'poster') return 'image/jpeg';
  if (variant === 'preview') return 'video/mp4';
  return drvExt === 'avif' ? 'image/avif' : `image/${drvExt}`;
}

function parseRange(header: string): R2Range | undefined {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return undefined;
  const [, a, b] = m;
  if (a === '' && b === '') return undefined;
  if (a === '') return { suffix: Number(b) };
  if (b === '') return { offset: Number(a) };
  return { offset: Number(a), length: Number(b) - Number(a) + 1 };
}

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
