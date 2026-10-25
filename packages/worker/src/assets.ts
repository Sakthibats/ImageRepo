import { Hono } from 'hono';
import type { Env, Viewer } from './types.js';
import { resolveViewer } from './access.js';
import type { AlbumDetail } from '@imagerepo/shared';
import { slugTag, tagReads } from './tags.js';
import { albumSummaries, folderSummaries, listMedia, PAGE_MAX, type Scope } from './listing.js';

export const assets = new Hono<{ Bindings: Env; Variables: { viewer: Viewer } }>({ strict: false });

const IMMUTABLE = 'public, max-age=31536000, immutable';

/** Variants a client may request. Anything else is rejected before touching R2. */
const VARIANTS = new Set(['320', '1024', '2048', 'poster', 'preview', 'orig']);

assets.use('*', async (c, next) => {
  const viewer = await resolveViewer(c.req.raw, c.env);
  if (viewer.kind === 'none') return c.json({ error: 'unauthorized' }, 401);
  c.set('viewer', viewer);
  await next();
});

// Owner-only reads behind the same viewer check. Registered BEFORE
// /:id/:variant: Hono matches in declaration order, and the wildcard would
// otherwise swallow "tags" or "albums" as an id.
assets.route('/tags', tagReads);

// Read live from D1 on every request, so nothing may cache them.
const LIVE = { 'cache-control': 'private, no-store' };

/** Every album with its count and cover. A few rows per album. */
assets.get('/albums', async (c) => c.json({ albums: await albumSummaries(c.env.DB) }, 200, LIVE));

/** One album with its folders, and how many photos are in none. */
assets.get('/albums/:id', async (c) => {
  const [album] = await albumSummaries(c.env.DB, c.req.param('id'));
  if (!album) return c.json({ error: 'no such album' }, 404);
  const folders = await folderSummaries(c.env.DB, { album: album.id });
  const loose = album.n - folders.reduce((n, f) => n + f.n, 0);
  return c.json({ ...album, loose, folders } satisfies AlbumDetail, 200, LIVE);
});

/**
 * A page of the library, an album, a folder (`folder=<id>`, or `loose`), or
 * the photos carrying tags (`tags=a,b`, `match=any` for either rather than
 * both). Oldest first unless `order=desc`; `after` is the previous page's `next`.
 */
assets.get('/media', async (c) => {
  const q = (k: string) => c.req.query(k);
  const album = q('album');
  const folder = q('folder');
  const tags = [...new Set((q('tags') ?? '').split(',').map(slugTag).filter(Boolean))].slice(0, 20);
  if (folder && folder !== 'loose' && !/^[0-9a-f]{12}$/.test(folder)) return c.json({ error: 'bad folder' }, 400);

  const scope: Scope = album
    ? { by: 'album', album, folder: folder === 'loose' ? null : folder }
    : tags.length ? { by: 'tags', tags, match: q('match') === 'any' ? 'any' : 'all' }
    : { by: 'library' };
  const page = await listMedia(c.env.DB, scope, 'owner', {
    order: q('order') === 'desc' ? 'desc' : 'asc', after: q('after'), limit: Number(q('limit')) || PAGE_MAX,
  });
  return c.json(page, 200, LIVE);
});

/**
 * Serves media. Keys are content-addressed, so every response is immutable and
 * safe to cache at the edge and in the browser forever.
 *
 * Range requests are honoured for video: without them, seeking in a clip makes
 * the browser refetch from byte zero.
 */
assets.get('/:id/:variant', async (c) => {
  const id = c.req.param('id');
  const variant = c.req.param('variant');

  if (!/^[0-9a-f]{32}$/.test(id)) return c.json({ error: 'bad id' }, 400);
  if (!VARIANTS.has(variant)) return c.json({ error: 'bad variant' }, 400);

  const row = await c.env.DB
    .prepare('SELECT id, kind, ext, drv_ext, orig_name FROM media WHERE id = ?1')
    .bind(id)
    .first<{ id: string; kind: string; ext: string; drv_ext: string; orig_name: string | null }>();
  if (!row) return c.json({ error: 'not found' }, 404);

  const { key, type } = resolveKey(row, variant);

  // R2 populates obj.range even on a full GET, so the presence of a range on
  // the object is not evidence the client asked for one. Track the request.
  const rangeHeader = c.req.header('range');
  const range = rangeHeader ? parseRange(rangeHeader) : undefined;
  const obj = range
    ? await c.env.BUCKET.get(key, { range })
    : await c.env.BUCKET.get(key);

  if (!obj || !('body' in obj)) return c.json({ error: 'object missing' }, 404);

  const headers = new Headers();
  headers.set('content-type', type);
  headers.set('cache-control', IMMUTABLE);
  headers.set('etag', obj.httpEtag);
  headers.set('accept-ranges', 'bytes');
  // Assets are private per viewer; never let a shared proxy hold them.
  headers.set('x-content-type-options', 'nosniff');

  if (variant === 'orig') {
    headers.set('content-disposition', `attachment; filename="${downloadName(row)}"`);
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
 * Prefer the name the file had on disk — a hash is useless in a Downloads
 * folder. Strip anything that could break out of the quoted header value.
 */
function downloadName(row: { id: string; kind: string; ext: string; orig_name: string | null }): string {
  const fallback = row.kind === 'video' ? `${row.id}.mp4` : `${row.id}.${row.ext}`;
  const raw = (row.orig_name ?? '').trim();
  if (!raw) return fallback;
  const safe = raw.replace(/[\\"\r\n\x00-\x1f]/g, '').replace(/[/]/g, '_').slice(0, 120);
  return safe || fallback;
}

function resolveKey(row: { id: string; kind: string; ext: string; drv_ext?: string }, variant: string) {
  if (variant === 'orig') {
    const ext = row.kind === 'video' ? 'mp4' : row.ext;
    return { key: `orig/${row.id}.${ext}`, type: row.kind === 'video' ? 'video/mp4' : 'image/jpeg' };
  }
  if (variant === 'poster') return { key: `post/${row.id}.jpg`, type: 'image/jpeg' };
  if (variant === 'preview') return { key: `prev/${row.id}.mp4`, type: 'video/mp4' };
  // Browser uploads encode with canvas, which cannot reliably emit AVIF, so
  // the format is recorded per media rather than assumed.
  const dx = row.drv_ext || 'avif';
  return { key: `drv/${row.id}/${variant}.${dx}`, type: dx === 'avif' ? 'image/avif' : `image/${dx}` };
}

/** "bytes=100-200" -> R2 range. Open-ended and suffix forms both appear in the wild. */
function parseRange(header: string): R2Range | undefined {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return undefined;
  const [, a, b] = m;
  if (a === '' && b === '') return undefined;
  if (a === '') return { suffix: Number(b) };
  if (b === '') return { offset: Number(a) };
  return { offset: Number(a), length: Number(b) - Number(a) + 1 };
}

