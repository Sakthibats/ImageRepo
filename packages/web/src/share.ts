import type { FolderSummary, MediaItem } from '@imagerepo/shared';

export type GuestItem = MediaItem & { t2: string };

export interface GuestAlbum {
  album: string; title: string; count: number;
  items: GuestItem[]; allowDownload: boolean;
  /** Only the folders this link shares, most recent first. */
  folders?: FolderSummary[];
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

/** Asset URLs carry the per-item tag the server issued with the manifest. */
export const guestAssetUrl = (token: string, item: GuestItem, variant: string) =>
  `/s/${token}/a/${item.id}/${variant}?t=${encodeURIComponent(item.t2)}`;
