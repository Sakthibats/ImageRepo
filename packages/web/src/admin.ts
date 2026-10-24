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
  } & ShareScope) => req<{ url: string; tokenHash: string }>('/admin/shares', json('POST', opts)),

  /** Changes what a link shows; its URL stays the same. */
  setShareScope: (tokenHash: string, scope: ShareScope) =>
    req(`/admin/shares/${tokenHash}`, json('PATCH', scope)),

  revokeShare: (tokenHash: string) =>
    req(`/admin/shares/${tokenHash}/revoke`, json('POST')),

  purgeSummary: () => req<PurgeSummary>('/admin/purge/summary'),

  /** One step of a purge; call with resume until `done`. */
  purgeStep: (confirm: string, resume: boolean) =>
    req<{ deleted: number; done: boolean }>('/admin/purge/everything', json('POST', { confirm, resume })),

  /** What to do with each picked file: upload it (with presigned URLs), or nothing. */
  inboxStart: (albumId: string, files: InboxFile[], folderId?: string) =>
    req<{ files: InboxStart[] }>('/admin/inbox/start', json('POST', { albumId, folderId, files })),

  inboxParts: (id: string, partNumbers: number[]) =>
    req<{ parts: { partNumber: number; url: string }[] }>('/admin/inbox/parts', json('POST', { id, partNumbers })),

  inboxFinish: (ids: string[]) =>
    req<{ files: InboxFinish[] }>('/admin/inbox/finish', json('POST', { ids })),

  inboxSummary: (albumId: string) =>
    req<InboxSummary>(`/admin/inbox/summary?album=${encodeURIComponent(albumId)}`),

  folders: (albumId: string) =>
    req<{ folders: { id: string; title: string; n: number }[]; loose: number }>(`/admin/albums/${albumId}/folders`),

  createFolder: (albumId: string, title: string) =>
    req<{ id: string }>(`/admin/albums/${albumId}/folders`, json('POST', { title })),

  /** `coverId: null` goes back to the folder's earliest photo. */
  updateFolder: (albumId: string, folderId: string, patch: { title?: string; coverId?: string | null }) =>
    req(`/admin/albums/${albumId}/folders/${folderId}`, json('PATCH', patch)),

  deleteFolder: (albumId: string, folderId: string) =>
    req(`/admin/albums/${albumId}/folders/${folderId}`, json('DELETE')),

  /** Files media already in the album into a folder; `null` makes them loose. */
  fileInFolder: (albumId: string, mediaIds: string[], folderId: string | null) =>
    req<{ moved: number }>(`/admin/albums/${albumId}/folder-items`, json('POST', { mediaIds, folderId })),
};

export interface ShareRow {
  token_hash: string; album_id: string; title: string | null; label: string | null;
  created_at: number; expires_at: number | null; allow_download: number;
  revoked: number; view_count: number; last_seen_at: number | null;
  has_passcode: number;
  scope: 'all' | 'folders'; include_loose: number;
  folders: { id: string; title: string }[];
}

/** What a share link shows: the whole album, or some folders and maybe the loose photos. */
export type ShareScope =
  | { scope: 'all' }
  | { scope: 'folders'; folderIds: string[]; includeLoose: boolean };

export interface PurgeSummary {
  photos: number; videos: number; bytes: number;
  albums: number; shares: number; tags: number; phrase: string;
  /** False unless signed in through Access as a person. */
  canPurge: boolean;
}

export interface InboxFile { id: string; name: string; size: number; lastModified?: number }

export type InboxStart =
  | { id: string; status: 'known' | 'queued' }
  | { id: string; status: 'refused'; error: string }
  | { id: string; status: 'upload'; url: string }
  | { id: string; status: 'upload'; partSize: number; partCount: number; done: number[] };

export interface InboxFinish { id: string; status: 'queued' | 'error'; error?: string; missing?: number[] }

export interface InboxSummary {
  counts: Partial<Record<'uploading' | 'ready' | 'claimed' | 'failed', number>>;
  maxAttempts: number;
  failed: { id: string; orig_name: string; error: string; attempts: number }[];
  /** Processing services seen in the last week, most recent first. */
  runners: Runner[];
}

export interface Runner { name: string; kinds: string[]; busy: number; lastSeen: number; online: boolean }

export const shareState = (s: ShareRow): 'active' | 'revoked' | 'expired' => {
  if (s.revoked) return 'revoked';
  if (s.expires_at && s.expires_at < Date.now() / 1000) return 'expired';
  return 'active';
};
