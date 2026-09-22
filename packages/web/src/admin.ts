import type { AlbumSummary } from './api.ts';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', ...init });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(detail.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

export const adminApi = {
  albums: () => req<{ albums: (AlbumSummary & { seeded_from?: string })[] }>('/admin/albums'),

  createAlbum: (title: string) => req<{ id: string }>('/admin/albums', json('POST', { title })),

  updateAlbum: (id: string, patch: { title?: string; description?: string; coverId?: string }) =>
    req('/admin/albums/' + id, json('PATCH', patch)),

  deleteAlbum: (id: string, alsoMedia: boolean) =>
    req<{ deletedMedia: number }>(`/admin/albums/${id}?media=${alsoMedia ? 'delete' : 'keep'}`, json('DELETE')),

  addToAlbum: (albumId: string, mediaIds: string[], mode: 'add' | 'move', fromAlbum?: string) =>
    req(`/admin/albums/${albumId}/media`, json('POST', { mediaIds, mode, fromAlbum })),

  removeFromAlbum: (albumId: string, mediaIds: string[]) =>
    req<{ removed: number }>(`/admin/albums/${albumId}/media`, json('DELETE', { mediaIds })),

  deleteMedia: (mediaIds: string[]) =>
    req<{ deleted: number }>('/admin/media', json('DELETE', { mediaIds })),

  setCaption: (id: string, caption: string) =>
    req('/admin/media/' + id, json('PATCH', { caption })),

  shares: () => req<{ shares: ShareRow[] }>('/admin/shares'),

  createShare: (opts: {
    albumId: string; label?: string; expiresInDays?: number;
    passcode?: string; allowDownload?: boolean;
  }) => req<{ url: string; tokenHash: string }>('/admin/shares', json('POST', opts)),

  revokeShare: (tokenHash: string) =>
    req(`/admin/shares/${tokenHash}/revoke`, json('POST')),

  checkKnown: (ids: string[]) =>
    req<{ known: string[] }>('/admin/upload/check', json('POST', { ids })),

  putObject: (id: string, variant: string, blob: Blob, ext: string) =>
    req<{ ok: true }>(`/admin/upload/${id}/${variant}?ext=${ext}`, {
      method: 'PUT',
      body: blob,
    }),

  commitUpload: (albumId: string, records: UploadRecord[]) =>
    req<{ added: number }>('/admin/upload/commit', json('POST', { albumId, records })),
};

export interface ShareRow {
  token_hash: string; album_id: string; title: string | null; label: string | null;
  created_at: number; expires_at: number | null; allow_download: number;
  revoked: number; view_count: number; last_seen_at: number | null;
  has_passcode: number;
}

export interface UploadRecord {
  id: string; width: number; height: number; bytes: number;
  takenAt?: number; thumbhash?: string; origName: string;
  drvExt: string; derivatives: string[];
}

export const shareState = (s: ShareRow): 'active' | 'revoked' | 'expired' => {
  if (s.revoked) return 'revoked';
  if (s.expires_at && s.expires_at < Date.now() / 1000) return 'expired';
  return 'active';
};
