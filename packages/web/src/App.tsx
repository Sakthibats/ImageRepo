import { useEffect, useState } from 'react';
import type { OwnerManifestItem } from '@imagerepo/shared';
import { fetchIndex, fetchAlbum, assetUrl, type AlbumSummary } from './api.ts';
import { thumbhashUrl } from './thumbhash.ts';
import { PhotoGrid } from './components/PhotoGrid.tsx';
import { Lightbox } from './components/Lightbox.tsx';
import { ShareView } from './components/ShareView.tsx';
import { shareTokenFromPath } from './share.ts';

export default function App() {
  // A /s/<token> URL is the guest experience; everything else is the owner app.
  const shareToken = shareTokenFromPath();
  if (shareToken) return <ShareView token={shareToken} />;
  return <OwnerApp />;
}

function OwnerApp() {
  const [albums, setAlbums] = useState<AlbumSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<AlbumSummary | null>(null);
  const [items, setItems] = useState<OwnerManifestItem[] | null>(null);
  const [lightbox, setLightbox] = useState<number | null>(null);

  useEffect(() => {
    fetchIndex()
      .then((d) => setAlbums(d.albums.filter((a) => a.n > 0)))
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  useEffect(() => {
    if (!open?.ver) { setItems(null); return; }
    let live = true;
    setItems(null);
    fetchAlbum(open.id, open.ver)
      .then((m) => { if (live) setItems(m.items); })
      .catch((e) => setError(String(e.message ?? e)));
    return () => { live = false; };
  }, [open]);

  if (error) {
    return (
      <main className="center">
        <h1>Can't load your library</h1>
        <p className="muted">{error}</p>
        {error === 'unauthorized' && <p className="muted">Sign in through Cloudflare Access, then reload.</p>}
      </main>
    );
  }

  if (!albums) return <main className="center"><p className="muted">Loading…</p></main>;

  if (!open) {
    return (
      <main>
        <header className="head">
          <h1>Photos</h1>
          <span className="muted">
            {albums.length} albums · {albums.reduce((n, a) => n + a.n, 0)} items
          </span>
        </header>
        <div className="albums">
          {albums.map((a) => (
            <button key={a.id} className="album" onClick={() => { setOpen(a); window.scrollTo(0, 0); }}>
              <div className="album-cover">
                {a.cover
                  ? <img src={assetUrl(a.cover, '320')} alt="" loading="lazy" />
                  : <div className="album-blank" />}
              </div>
              <div className="album-name">{a.title}</div>
              <div className="muted small">{a.n} items</div>
            </button>
          ))}
        </div>
      </main>
    );
  }

  return (
    <main>
      <header className="head">
        <button className="back" onClick={() => { setOpen(null); setItems(null); }}>‹ Albums</button>
        <h1>{open.title}</h1>
        <span className="muted">{open.n} items</span>
      </header>

      {!items
        ? <p className="muted center">Loading…</p>
        : <PhotoGrid items={items} onOpen={setLightbox}
                     urlFor={(it, v) => assetUrl(it.id, v)} />}

      {items && lightbox !== null && (
        <Lightbox
          items={items}
          index={lightbox}
          onClose={() => setLightbox(null)}
          onIndex={setLightbox}
          urlFor={(it, v) => assetUrl(it.id, v)}
        />
      )}
    </main>
  );
}
