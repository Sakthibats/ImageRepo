import { useCallback, useEffect, useMemo, useState } from 'react';
import type { OwnerManifestItem } from '@imagerepo/shared';
import { fetchIndex, fetchAlbum, assetUrl, type AlbumSummary } from './api.ts';
import { adminApi } from './admin.ts';
import { PhotoGrid } from './components/PhotoGrid.tsx';
import { Lightbox } from './components/Lightbox.tsx';
import { ShareView } from './components/ShareView.tsx';
import { AdminBar, Confirm } from './components/AdminBar.tsx';
import { ShareManager } from './components/ShareManager.tsx';
import { Uploader } from './components/Uploader.tsx';
import { shareTokenFromPath } from './share.ts';

export default function App() {
  // A /s/<token> URL is the guest experience; everything else is the owner app.
  const shareToken = shareTokenFromPath();
  if (shareToken) return <ShareView token={shareToken} />;
  return <OwnerApp />;
}

type Dialog =
  | { kind: 'none' }
  | { kind: 'share'; album: AlbumSummary }
  | { kind: 'newAlbum' }
  | { kind: 'renameAlbum'; album: AlbumSummary }
  | { kind: 'confirmDeleteMedia'; ids: string[] }
  | { kind: 'confirmDeleteAlbum'; album: AlbumSummary };

function OwnerApp() {
  const [albums, setAlbums] = useState<AlbumSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<AlbumSummary | null>(null);
  const [items, setItems] = useState<OwnerManifestItem[] | null>(null);
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [lastClicked, setLastClicked] = useState<number | null>(null);
  const [dialog, setDialog] = useState<Dialog>({ kind: 'none' });
  const [text, setText] = useState('');
  const [toast, setToast] = useState<string | null>(null);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2600);
  }, []);

  const loadIndex = useCallback(async () => {
    try {
      const d = await fetchIndex();
      setAlbums(d.albums);
      setOpen((cur) => (cur ? d.albums.find((a) => a.id === cur.id) ?? null : null));
    } catch (e) { setError((e as Error).message); }
  }, []);

  useEffect(() => { void loadIndex(); }, [loadIndex]);

  const reloadAlbum = useCallback(async (album: AlbumSummary | null) => {
    if (!album?.ver) { setItems(album ? [] : null); return; }
    try { setItems((await fetchAlbum(album.id, album.ver)).items); }
    catch (e) { setError((e as Error).message); }
  }, []);

  useEffect(() => { setSelection(new Set()); void reloadAlbum(open); }, [open, reloadAlbum]);

  /** Refresh both the index and the open album after a mutation. */
  const refresh = useCallback(async () => {
    const d = await fetchIndex().catch(() => null);
    if (!d) return;
    setAlbums(d.albums);
    const updated = open ? d.albums.find((a) => a.id === open.id) ?? null : null;
    setOpen(updated);
    await reloadAlbum(updated);
    setSelection(new Set());
  }, [open, reloadAlbum]);

  const toggle = useCallback((id: string, index: number, shiftKey: boolean) => {
    setSelection((prev) => {
      const next = new Set(prev);
      if (shiftKey && lastClicked !== null && items) {
        const [a, b] = [lastClicked, index].sort((x, y) => x - y);
        for (let i = a; i <= b; i++) next.add(items[i].id);
      } else if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setLastClicked(index);
  }, [lastClicked, items]);

  const selectedIds = useMemo(() => [...selection], [selection]);

  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try { await fn(); await refresh(); notify(msg); }
    catch (e) { notify(`Failed: ${(e as Error).message}`); }
  };

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

  // ------------------------------------------------------------ album list
  if (!open) {
    return (
      <main>
        <header className="head">
          <h1>Photos</h1>
          <span className="muted">
            {albums.length} albums · {albums.reduce((n, a) => n + a.n, 0)} items
          </span>
          <button className="btn primary small push"
                  onClick={() => { setText(''); setDialog({ kind: 'newAlbum' }); }}>
            New album
          </button>
        </header>

        <div className="albums">
          {albums.map((a) => (
            <div key={a.id} className="album fade-in">
              <button className="album-hit" onClick={() => { setOpen(a); window.scrollTo(0, 0); }}>
                <div className="album-cover">
                  {a.cover
                    ? <img src={assetUrl(a.cover, '320')} alt="" loading="lazy" />
                    : <div className="album-blank" />}
                </div>
                <div className="album-name">{a.title}</div>
                <div className="muted small">{a.n} items</div>
              </button>
              <div className="album-tools">
                <button className="icon-btn" title="Share"
                        onClick={() => setDialog({ kind: 'share', album: a })}>↗</button>
                <button className="icon-btn" title="Rename"
                        onClick={() => { setText(a.title); setDialog({ kind: 'renameAlbum', album: a }); }}>✎</button>
                <button className="icon-btn danger" title="Delete album"
                        onClick={() => setDialog({ kind: 'confirmDeleteAlbum', album: a })}>🗑</button>
              </div>
            </div>
          ))}
        </div>

        <Dialogs />
        {toast && <div className="toast slide-up">{toast}</div>}
      </main>
    );
  }

  // ----------------------------------------------------------- album view
  return (
    <main>
      <header className="head">
        <button className="back" onClick={() => setOpen(null)}>‹ Albums</button>
        <h1>{open.title}</h1>
        <span className="muted">{open.n} items</span>
        <div className="push row-gap">
          {items && items.length > 0 && (
            <button className="btn small" onClick={() =>
              setSelection((s) => s.size === items.length ? new Set() : new Set(items.map((i) => i.id)))}>
              {selection.size === items.length ? 'Clear' : 'Select all'}
            </button>
          )}
          <button className="btn small" onClick={() => setDialog({ kind: 'share', album: open })}>Share</button>
        </div>
      </header>

      <Uploader albumId={open.id} onDone={() => { void refresh(); notify('Upload complete'); }} />

      {!items ? <p className="muted center">Loading…</p>
        : !items.length ? <p className="muted center">This album is empty.</p>
        : <PhotoGrid items={items} onOpen={setLightbox}
                     urlFor={(it, v) => assetUrl(it.id, v)}
                     selection={selection} onToggle={toggle} />}

      {items && lightbox !== null && (
        <Lightbox
          items={items}
          index={lightbox}
          onClose={() => setLightbox(null)}
          onIndex={setLightbox}
          urlFor={(it, v) => assetUrl(it.id, v)}
        />
      )}

      <AdminBar
        count={selection.size}
        albums={albums}
        currentAlbum={open.id}
        onClear={() => setSelection(new Set())}
        onMove={(to) => void act(
          () => adminApi.addToAlbum(to, selectedIds, 'move', open.id),
          `Moved ${selectedIds.length} to ${albums.find((a) => a.id === to)?.title}`)}
        onCopy={(to) => void act(
          () => adminApi.addToAlbum(to, selectedIds, 'add'),
          `Copied ${selectedIds.length} to ${albums.find((a) => a.id === to)?.title}`)}
        onRemove={() => void act(
          () => adminApi.removeFromAlbum(open.id, selectedIds),
          `Removed ${selectedIds.length} from this album`)}
        onSetCover={() => void act(
          () => adminApi.updateAlbum(open.id, { coverId: selectedIds[0] }), 'Cover updated')}
        onDelete={() => setDialog({ kind: 'confirmDeleteMedia', ids: selectedIds })}
      />

      <Dialogs />
      {toast && <div className="toast slide-up">{toast}</div>}
    </main>
  );

  function Dialogs() {
    if (dialog.kind === 'share') {
      return <ShareManager albumId={dialog.album.id} albumTitle={dialog.album.title}
                           onClose={() => setDialog({ kind: 'none' })} />;
    }
    if (dialog.kind === 'newAlbum' || dialog.kind === 'renameAlbum') {
      const renaming = dialog.kind === 'renameAlbum';
      return (
        <Confirm
          title={renaming ? 'Rename album' : 'New album'}
          confirmLabel={renaming ? 'Rename' : 'Create'}
          body={
            <input className="input" autoFocus value={text} placeholder="Album name"
                   onChange={(e) => setText(e.target.value)} />
          }
          onCancel={() => setDialog({ kind: 'none' })}
          onConfirm={() => {
            const title = text.trim();
            setDialog({ kind: 'none' });
            if (!title) return;
            void act(
              () => renaming
                ? adminApi.updateAlbum((dialog as any).album.id, { title })
                : adminApi.createAlbum(title),
              renaming ? 'Album renamed' : `Created “${title}”`);
          }}
        />
      );
    }
    if (dialog.kind === 'confirmDeleteMedia') {
      const n = dialog.ids.length;
      return (
        <Confirm
          title={`Delete ${n} item${n === 1 ? '' : 's'}?`}
          danger
          confirmLabel="Delete permanently"
          body={<p className="muted">
            This removes the originals and every generated size from storage, in
            all albums. It cannot be undone.
          </p>}
          onCancel={() => setDialog({ kind: 'none' })}
          onConfirm={() => {
            const ids = dialog.ids;
            setDialog({ kind: 'none' });
            void act(() => adminApi.deleteMedia(ids), `Deleted ${ids.length}`);
          }}
        />
      );
    }
    if (dialog.kind === 'confirmDeleteAlbum') {
      const album = dialog.album;
      return (
        <Confirm
          title={`Delete album “${album.title}”?`}
          danger
          confirmLabel="Delete album, keep photos"
          body={<p className="muted">
            The album and its share links go away. The {album.n} photos stay in
            your library and in any other album they belong to.
          </p>}
          onCancel={() => setDialog({ kind: 'none' })}
          onConfirm={() => {
            setDialog({ kind: 'none' });
            setOpen(null);
            void act(() => adminApi.deleteAlbum(album.id, false), `Deleted “${album.title}”`);
          }}
        />
      );
    }
    return null;
  }
}
