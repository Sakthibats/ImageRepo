import type { AlbumManifest, FolderSummary, OwnerManifestItem } from '@imagerepo/shared';

export interface AlbumSummary {
  id: string; title: string; n: number;
  cover: string | null; ver: string | null; updated: number;
  newest: number | null;
}

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

export const fetchIndex = () =>
  get<{ ver: string; albums: AlbumSummary[] }>('/a/manifest/index');

export const fetchAlbum = (id: string, ver: string) =>
  get<AlbumManifest & { items: OwnerManifestItem[]; folders?: FolderSummary[] }>(`/a/manifest/album/${id}/${ver}`);

export const assetUrl = (id: string, variant: string) => `/a/${id}/${variant}`;

/** Picks the smallest derivative that still covers the rendered size. */
export function pickWidth(displayWidth: number): 320 | 1024 | 2048 {
  const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1;
  const needed = displayWidth * dpr;
  if (needed <= 320) return 320;
  if (needed <= 1024) return 1024;
  return 2048;
}
