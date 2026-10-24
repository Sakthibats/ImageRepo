import { useEffect, useMemo, useState } from 'react';
import type { OwnerManifestItem } from '@imagerepo/shared';
import { openShareSession, guestAssetUrl, type GuestAlbum, type GuestItem } from '../share.ts';
import { PhotoGrid } from './PhotoGrid.tsx';
import { Lightbox } from './Lightbox.tsx';
import { FolderStrip, itemsIn, type FolderView } from './FolderStrip.tsx';
import { loadSort, saveSort, type SortOrder } from '../tags.ts';

/** The whole guest experience. No login, no album switching, no admin. */
export function ShareView({ token }: { token: string }) {
  const [album, setAlbum] = useState<GuestAlbum | null>(null);
  const [needPasscode, setNeedPasscode] = useState(false);
  const [passcode, setPasscode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [view, setView] = useState<FolderView>('all');
  const [sort, setSort] = useState<SortOrder>(loadSort);

  // The server sends items oldest first: "All photos" is every folder the
  // link shares, combined by date. Newest first is its mirror.
  const shown = useMemo(() => {
    if (!album) return [];
    const list = itemsIn(album.items, view);
    return sort === 'desc' ? [...list].reverse() : list;
  }, [album, view, sort]);
  const byId = useMemo(() => new Map((album?.items ?? []).map((i) => [i.id, i])), [album]);

  const attempt = async (code?: string) => {
    setBusy(true);
    setError(null);
    const r = await openShareSession(token, code);
    setBusy(false);
    if (r.ok) { setAlbum(r.album); setNeedPasscode(false); return; }
    if (r.needPasscode) { setNeedPasscode(true); setError(r.error ?? null); return; }
    setError(r.error ?? 'Unable to open this link.');
  };

  useEffect(() => { void attempt(); }, [token]);

  if (busy && !album && !needPasscode) {
    return <main className="center"><p className="muted">Opening…</p></main>;
  }

  if (needPasscode) {
    return (
      <main className="center">
        <h1>This album is passcode protected</h1>
        <form
          className="pc-form"
          onSubmit={(e) => { e.preventDefault(); void attempt(passcode); }}
        >
          <input
            type="password"
            className="pc-input"
            placeholder="Passcode"
            value={passcode}
            autoFocus
            autoComplete="off"
            onChange={(e) => setPasscode(e.target.value)}
          />
          <button className="pc-btn" type="submit" disabled={busy || !passcode}>
            {busy ? 'Checking…' : 'View album'}
          </button>
        </form>
        {error && <p className="muted small">{error}</p>}
      </main>
    );
  }

  if (error || !album) {
    return (
      <main className="center">
        <h1>Link unavailable</h1>
        <p className="muted">{error ?? 'This link is invalid, expired, or has been revoked.'}</p>
      </main>
    );
  }

  const urlFor = (item: any, variant: string) =>
    guestAssetUrl(token, item as GuestItem, variant);
  // Covers are ids; a guest can only load an item it holds a tag for.
  const coverUrl = (id: string) => {
    const item = byId.get(id);
    return item ? guestAssetUrl(token, item, '320') : null;
  };
  const firstPhoto = album.items.find((i) => i.k === 'photo') ?? album.items[0];

  return (
    <main>
      <header className="head">
        <h1>{album.title}</h1>
        <span className="muted">{album.count} items</span>
        {album.items.length > 1 && (
          <div className="push">
            <button className="btn small sort" title="Change the order photos are shown in"
                    onClick={() => {
                      const next: SortOrder = sort === 'asc' ? 'desc' : 'asc';
                      setSort(next); saveSort(next); setLightbox(null); window.scrollTo(0, 0);
                    }}>
              <span aria-hidden="true">{sort === 'asc' ? '↑' : '↓'}</span>
              {sort === 'asc' ? 'Oldest first' : 'Newest first'}
            </button>
          </div>
        )}
      </header>

      <FolderStrip
        folders={album.folders ?? []} total={album.items.length}
        loose={album.items.filter((i) => !i.f).length}
        view={view} onView={(v) => { setView(v); setLightbox(null); }}
        coverUrl={coverUrl} allCover={firstPhoto?.id ?? null}
      />

      <PhotoGrid items={shown} onOpen={setLightbox} urlFor={urlFor} />

      {lightbox !== null && (
        <Lightbox
          items={shown as unknown as OwnerManifestItem[]}
          index={lightbox}
          onClose={() => setLightbox(null)}
          onIndex={setLightbox}
          urlFor={urlFor}
          allowDownload={album.allowDownload}
        />
      )}
    </main>
  );
}
