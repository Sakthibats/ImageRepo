import type { AlbumSummary, FolderSummary, MediaItem, MediaPage, OwnerMediaItem } from '@imagerepo/shared';
import { FOLDER_IN_SCOPE, IN_SCOPE } from './share.js';

/**
 * Every way of browsing the library is a scope, and every scope is listed by
 * listMedia: one page in date order, read from one index range, so a page
 * costs about as many D1 rows as it returns. A new way to browse (a person, an
 * object, a date range) is one more case here, not a new route or file.
 */
export type Scope =
  | { by: 'library' }
  /** `folder` undefined is the whole album, null its loose photos. */
  | { by: 'album'; album: string; folder?: string | null }
  /** What a share link shows (IN_SCOPE). */
  | { by: 'share'; tokenHash: string }
  | { by: 'tags'; tags: string[]; match: 'all' | 'any' };

/** Who the page is for. Only the owner's shape has location. */
export type Shape = 'owner' | 'guest';

export const PAGE_MAX = 500;

/** "<sort date>_<id>" of the last item of a page. */
const CURSOR = /^(-?\d+)_([0-9a-f]{32})$/;

export async function listMedia(
  db: D1Database, scope: Scope, shape: Shape,
  o: { order?: 'asc' | 'desc'; after?: string | null; limit?: number } = {},
): Promise<MediaPage<MediaItem | OwnerMediaItem>> {
  const args: unknown[] = [];
  const p = (v: unknown) => `?${args.push(v)}`;
  const where: string[] = [];

  // Album and share pages walk album_media's (album_id, sort_ts) index; the
  // library and tags walk media's.
  let from = 'media m';
  let ts = 'm.sort_ts';
  let id = 'm.id';
  let folder = '';
  switch (scope.by) {
    case 'library':
      break;
    case 'tags':
      where.push(`m.id IN (SELECT media_id FROM media_tags WHERE tag_id IN (${scope.tags.map(p).join(',')})
        GROUP BY media_id${scope.match === 'all' ? ` HAVING COUNT(*) = ${p(scope.tags.length)}` : ''})`);
      break;
    case 'album':
      from = 'album_media am JOIN media m ON m.id = am.media_id';
      [ts, id, folder] = ['am.sort_ts', 'am.media_id', ', am.folder_id'];
      where.push(`am.album_id = ${p(scope.album)}`);
      if (scope.folder === null) where.push('am.folder_id IS NULL');
      else if (scope.folder !== undefined) where.push(`am.folder_id = ${p(scope.folder)}`);
      break;
    case 'share':
      from = `share_links s JOIN album_media am ON am.album_id = s.album_id
              JOIN media m ON m.id = am.media_id`;
      [ts, id, folder] = ['am.sort_ts', 'am.media_id', ', am.folder_id'];
      where.push(`s.token_hash = ${p(scope.tokenHash)}`, IN_SCOPE);
      break;
  }

  const desc = o.order === 'desc';
  const cursor = CURSOR.exec(o.after ?? '');
  if (cursor) where.push(`(${ts}, ${id}) ${desc ? '<' : '>'} (${p(Number(cursor[1]))}, ${p(cursor[2])})`);
  const limit = Math.min(Math.max(Math.floor(o.limit ?? PAGE_MAX), 1), PAGE_MAX);
  const dir = desc ? 'DESC' : 'ASC';

  // Named column by column, never m.*, so location cannot reach a guest even by accident.
  const { results } = await db.prepare(`
    SELECT m.id, m.kind, m.width, m.height, m.taken_at, m.thumbhash, m.duration_ms, m.caption, m.rev
           ${shape === 'owner' ? ', m.lat, m.lon, m.place' : ''}${folder}, ${ts} AS ts
    FROM ${from}
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ${ts} ${dir}, ${id} ${dir}
    LIMIT ${p(limit)}
  `).bind(...args).all<Row>();

  const last = results.at(-1);
  return {
    items: results.map((r) => toItem(r, shape)),
    next: results.length === limit && last ? `${last.ts}_${last.id}` : null,
  };
}

interface Row {
  id: string; kind: 'photo' | 'video'; width: number | null; height: number | null;
  taken_at: number | null; thumbhash: string | null; duration_ms: number | null; caption: string | null; rev: number;
  folder_id?: string | null; lat?: number | null; lon?: number | null; place?: string | null; ts: number;
}

function toItem(r: Row, shape: Shape): MediaItem | OwnerMediaItem {
  const item: OwnerMediaItem = { id: r.id, k: r.kind, w: r.width ?? 0, h: r.height ?? 0 };
  if (r.taken_at) item.t = r.taken_at;
  if (r.thumbhash) item.th = r.thumbhash;
  if (r.duration_ms) item.d = r.duration_ms;
  if (r.caption) item.c = r.caption;
  if (r.folder_id) item.f = r.folder_id;
  if (r.rev) item.r = r.rev;
  if (shape === 'owner') {
    if (r.lat != null) item.lat = r.lat;
    if (r.lon != null) item.lon = r.lon;
    if (r.place) item.place = r.place;
  }
  return item;
}

/**
 * The earliest photo of an album_media range (a video poster is a frame grab
 * and makes a worse cover), else its earliest item. Each is a walk from the
 * start of an index range that stops at the first match.
 */
const earliest = (range: string) => `COALESCE(
  (SELECT x.media_id FROM album_media x JOIN media xm ON xm.id = x.media_id
    WHERE ${range} AND xm.kind = 'photo' ORDER BY x.sort_ts, x.media_id LIMIT 1),
  (SELECT x.media_id FROM album_media x WHERE ${range} ORDER BY x.sort_ts, x.media_id LIMIT 1))`;

/** Adds the cover's revision, for its URL, to each row of `sql`, whose cover is `cover`. */
const withCoverRev = (sql: string, cover = 'q.cover') =>
  `SELECT q.*, (SELECT rev FROM media WHERE id = ${cover}) AS coverRev FROM (${sql}) q`;

/** Albums with their counts, covers and newest dates, or just one: a few rows per album. */
export async function albumSummaries(db: D1Database, only?: string): Promise<AlbumSummary[]> {
  const sql = withCoverRev(`
    SELECT a.id, a.title, a.item_count AS n,
           COALESCE(a.cover_id, ${earliest('x.album_id = a.id')}) AS cover,
           (SELECT MAX(sort_ts) FROM album_media WHERE album_id = a.id) AS newest
    FROM albums a ${only ? 'WHERE a.id = ?1' : ''}`);
  const stmt = db.prepare(`${sql} ORDER BY q.title`);
  const { results } = await (only ? stmt.bind(only) : stmt).all<AlbumSummary & { coverRev: number | null }>();
  return results.map(({ coverRev, ...a }) => ({ ...a, ...(coverRev ? { coverRev } : {}) }));
}

/**
 * An album's folders, most recent first with empty ones leading. For a share
 * link, only the folders it shows and none that are empty, and a pinned cover
 * only if the link shows that photo; otherwise the folder's earliest.
 */
export async function folderSummaries(
  db: D1Database, from: { album: string } | { share: string },
): Promise<FolderSummary[]> {
  const range = 'x.album_id = f.album_id AND x.folder_id = f.id';
  const owner = 'album' in from;
  const pinned = owner ? 'f.cover_id' : `CASE WHEN EXISTS (
      SELECT 1 FROM album_media am WHERE am.media_id = f.cover_id AND am.album_id = s.album_id AND ${IN_SCOPE}
    ) THEN f.cover_id END`;
  const { results } = await db.prepare(withCoverRev(`
    SELECT f.id, f.title, f.item_count AS n, ${pinned} AS pinned, ${earliest(range)} AS first,
           (SELECT MAX(x.sort_ts) FROM album_media x WHERE ${range}) AS newest
    ${owner
      ? 'FROM folders f WHERE f.album_id = ?1'
      : `FROM share_links s JOIN folders f ON f.album_id = s.album_id
         WHERE s.token_hash = ?1 AND ${FOLDER_IN_SCOPE} AND f.item_count > 0`}
  `, 'COALESCE(q.pinned, q.first)')).bind(owner ? from.album : from.share).all<{
    id: string; title: string; n: number; pinned: string | null; first: string | null;
    coverRev: number | null; newest: number | null;
  }>();

  return results
    .map((f): FolderSummary => ({
      id: f.id, title: f.title, n: f.n, cover: f.pinned ?? f.first,
      ...(f.coverRev ? { coverRev: f.coverRev } : {}), ...(f.pinned ? { coverPinned: true } : {}),
      newest: f.newest,
    }))
    // An empty folder is usually one just made to be filled, so it leads.
    .sort((a, b) =>
      Number(a.n > 0) - Number(b.n > 0) ||
      (b.newest ?? 0) - (a.newest ?? 0) ||
      a.title.localeCompare(b.title));
}
