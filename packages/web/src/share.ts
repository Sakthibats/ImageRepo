import type { FolderSummary, MediaItem, MediaPage } from '@imagerepo/shared';

export type GuestItem = MediaItem & { t2: string };

/** What a link shows, before its photos: they come a page at a time from fetchGuestPage. */
export interface GuestAlbum {
  album: string; title: string; count: number;
  /** How many of those are in no folder. */
  loose: number;
  allowDownload: boolean;
  /** Only the folders this link shares, most recent first. */
  folders: FolderSummary[];
}

/** /s/<token> -> the token, or null when this is the owner app. */
export function shareTokenFromPath(): string | null {
  const m = /^\/s\/([A-Za-z0-9_-]{16,64})\/?$/.exec(window.location.pathname);
  return m ? m[1] : null;
}

export async function openShareSession(
  token: string, passcode?: string,
): Promise<{ ok: true; album: GuestAlbum } | { ok: false; needPasscode?: boolean; error?: string }> {
  const res = await fetch(`/s/${token}/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(passcode ? { passcode } : {}),
    credentials: 'same-origin',
  });
  if (res.status === 401) {
    const d = await res.json().catch(() => ({})) as { needPasscode?: boolean; error?: string };
    return { ok: false, needPasscode: true, error: d.error };
  }
  if (!res.ok) return { ok: false, error: 'This link is invalid, expired, or has been revoked.' };
  return { ok: true, album: await res.json() as GuestAlbum };
}

/** One page of what the link shows. Needs the session cookie openShareSession set. */
export async function fetchGuestPage(
  token: string, o: { after?: string; limit?: number },
): Promise<MediaPage<GuestItem>> {
  const q = new URLSearchParams();
  if (o.after) q.set('after', o.after);
  if (o.limit) q.set('limit', String(o.limit));
  const res = await fetch(`/s/${token}/media?${q}`, { credentials: 'same-origin' });
  if (!res.ok) throw new Error('This link is invalid, expired, or has been revoked.');
  return res.json() as Promise<MediaPage<GuestItem>>;
}

/** Asset URLs carry the per-item tag the server issued with the page, and the item's revision. */
export const guestAssetUrl = (token: string, item: { id: string; t2: string; r?: number }, variant: string) =>
  `/s/${token}/a/${item.id}/${variant}?t=${encodeURIComponent(item.t2)}${item.r ? `&r=${item.r}` : ''}`;
