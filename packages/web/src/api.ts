import type { AlbumDetail, AlbumSummary, MediaItem, MediaPage, OwnerMediaItem } from '@imagerepo/shared';

/**
 * Same-origin requests. The app is served by the Worker itself, so Cloudflare
 * Access's CF_Authorization cookie is sent automatically — a separate Pages
 * origin would not receive it.
 */
async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin' });
  if (res.status === 401) throw new Error('unauthorized');
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

/** Every album with its count and cover. */
export const fetchAlbums = () => get<{ albums: AlbumSummary[] }>('/a/albums');

/** One album's counts and folders. */
export const fetchAlbumDetail = (id: string) => get<AlbumDetail>(`/a/albums/${encodeURIComponent(id)}`);

/** What /a/media lists: the library, an album or one of its folders ('loose' for none), or photos with tags. */
export type Listing =
  | { album: string; folder?: string }
  | { tags: string[]; match: 'all' | 'any' }
  | Record<string, never>;

/** One page of a listing. `after` is the previous page's `next`. */
export function fetchPage(
  listing: Listing, o: { order?: 'asc' | 'desc'; after?: string; limit?: number } = {},
): Promise<MediaPage<OwnerMediaItem>> {
  const q = new URLSearchParams();
  if ('album' in listing) {
    q.set('album', listing.album);
    if (listing.folder) q.set('folder', listing.folder);
  } else if ('tags' in listing) {
    q.set('tags', listing.tags.join(','));
    q.set('match', listing.match);
  }
  if (o.order) q.set('order', o.order);
  if (o.after) q.set('after', o.after);
  if (o.limit) q.set('limit', String(o.limit));
  return get(`/a/media?${q}`);
}

/** Small, so the first photos show before the rest of the album has arrived. */
const FIRST_PAGE = 150;

/**
 * Every page of a listing, one after another, handing the items so far to
 * `onItems` as each page arrives. Stops early, returning null, once `live()`
 * is false: the viewer has moved on.
 */
export async function loadAll<T extends MediaItem>(
  page: (after: string | undefined, limit: number) => Promise<MediaPage<T>>,
  onItems: (items: T[]) => void,
  live: () => boolean,
): Promise<T[] | null> {
  let items: T[] = [];
  let after: string | undefined;
  do {
    const p = await page(after, items.length ? 500 : FIRST_PAGE);
    if (!live()) return null;
    items = [...items, ...p.items];
    onItems(items);
    after = p.next ?? undefined;
  } while (after);
  return items;
}

export const assetUrl = (id: string, variant: string) => `/a/${id}/${variant}`;

/** Picks the smallest derivative that still covers the rendered size. */
export function pickWidth(displayWidth: number): 320 | 1024 | 2048 {
  const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1;
  const needed = displayWidth * dpr;
  if (needed <= 320) return 320;
  if (needed <= 1024) return 1024;
  return 2048;
}
