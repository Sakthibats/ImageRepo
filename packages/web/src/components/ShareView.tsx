import { useEffect, useState } from 'react';
import type { OwnerManifestItem } from '@imagerepo/shared';
import { openShareSession, guestAssetUrl, type GuestAlbum, type GuestItem } from '../share.ts';
import { PhotoGrid } from './PhotoGrid.tsx';
import { Lightbox } from './Lightbox.tsx';

/** The whole guest experience. No login, no album switching, no admin. */
export function ShareView({ token }: { token: string }) {
  const [album, setAlbum] = useState<GuestAlbum | null>(null);
  const [needPasscode, setNeedPasscode] = useState(false);
  const [passcode, setPasscode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [lightbox, setLightbox] = useState<number | null>(null);

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

  return (
    <main>
      <header className="head">
        <h1>{album.title}</h1>
        <span className="muted">{album.count} items</span>
      </header>

      <PhotoGrid items={album.items} onOpen={setLightbox} urlFor={urlFor} />

      {lightbox !== null && (
        <Lightbox
          items={album.items as unknown as OwnerManifestItem[]}
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
