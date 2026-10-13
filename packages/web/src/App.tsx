import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OwnerManifestItem } from '@imagerepo/shared';
import { fetchIndex, fetchAlbum, assetUrl, type AlbumSummary } from './api.ts';
import { adminApi } from './admin.ts';
import { PhotoGrid } from './components/PhotoGrid.tsx';
import { Lightbox } from './components/Lightbox.tsx';
import { ShareView } from './components/ShareView.tsx';
import { AdminBar, Confirm } from './components/AdminBar.tsx';
import { ShareManager } from './components/ShareManager.tsx';
import { Uploader } from './components/Uploader.tsx';
import { TimelineView } from './components/TimelineView.tsx';
import { TagsView } from './components/TagsView.tsx';
import { TagDialog } from './components/TagDialog.tsx';
import { shareTokenFromPath } from './share.ts';
import { loadSort, saveSort, type Item, type SortOrder } from './tags.ts';

type Tab = 'photos' | 'albums' | 'tags';

export default function App() {
  // A /s/<token> URL is the guest experience; everything else is the owner app.
  const shareToken = shareTokenFromPath();
  if (shareToken) return <ShareView token={shareToken} />;
  return <OwnerApp />;
}

/** Most recent album first; empty albums sink, then alphabetical as a tiebreak. */
function sortAlbums(albums: AlbumSummary[]): AlbumSummary[] {
  return [...albums].sort((a, b) =>
    (b.newest ?? 0) - (a.newest ?? 0) || a.title.localeCompare(b.title));
}

/**
 * Publishes the sticky header's height as --head-h, so the month headings can
 * stick directly beneath it. The header wraps on narrow screens, so its height
 * is not a constant CSS could know.
 */
function useHeadHeight() {
  const observer = useRef<ResizeObserver | null>(null);
  return useCallback((el: HTMLElement | null) => {
    observer.current?.disconnect();
    if (!el) return;
    const publish = () =>
      document.documentElement.style.setProperty('--head-h', `${el.offsetHeight}px`);
    observer.current = new ResizeObserver(publish);
    observer.current.observe(el);
    publish();
  }, []);
}

type Dialog =
  | { kind: 'none' }
  | { kind: 'share'; album: AlbumSummary }
  | { kind: 'newAlbum' }
  | { kind: 'renameAlbum'; album: AlbumSummary }
  | { kind: 'confirmDeleteMedia'; ids: string[] }
  | { kind: 'confirmDeleteAlbum'; album: AlbumSummary };

function OwnerApp() {
  // Dates are the default way in; albums and tags are alternative lenses on
  // the same library rather than separate places things live.
  const [tab, setTab] = useState<Tab>('photos');
  const [viewItems, setViewItems] = useState<Item[]>([]);
  const [globalLb, setGlobalLb] = useState<{ items: Item[]; index: number } | null>(null);
  const [tagOpen, setTagOpen] = useState(false);
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
  const [sort, setSort] = useState<SortOrder>(loadSort);
  const headRef = useHeadHeight();

  const notify = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2600);
  }, []);

  const loadIndex = useCallback(async () => {
    try {
      const d = await fetchIndex();
      setAlbums(sortAlbums(d.albums));
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
    setAlbums(sortAlbums(d.albums));
    const updated = open ? d.albums.find((a) => a.id === open.id) ?? null : null;
    setOpen(updated);
    await reloadAlbum(updated);
    setSelection(new Set());
  }, [open, reloadAlbum]);

  const toggleIn = useCallback((list: { id: string }[]) =>
    (id: string, index: number, shiftKey: boolean) => {
      setSelection((prev) => {
        const next = new Set(prev);
        if (shiftKey && lastClicked !== null && list.length) {
          const [a, b] = [lastClicked, index].sort((x, y) => x - y);
          for (let i = a; i <= b && i < list.length; i++) next.add(list[i].id);
        } else if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      setLastClicked(index);
    }, [lastClicked]);

  // An album's manifest is baked oldest first; the other order is its mirror.
  const shown = useMemo(
    () => (items && sort === 'desc' ? [...items].reverse() : items), [items, sort]);

  const toggle = useCallback((id: string, index: number, shiftKey: boolean) =>
    toggleIn(shown ?? [])(id, index, shiftKey), [toggleIn, shown]);

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

  const sortButton = (
    <button className="btn small sort" title="Change the order photos are shown in"
            onClick={() => {
              const next: SortOrder = sort === 'asc' ? 'desc' : 'asc';
              setSort(next); saveSort(next);
              // Positions in the list change, so a range selection anchor no longer means anything.
              setLastClicked(null); setLightbox(null); setGlobalLb(null);
              window.scrollTo(0, 0);
            }}>
      <span aria-hidden="true">{sort === 'asc' ? '↑' : '↓'}</span>
      {sort === 'asc' ? 'Oldest first' : 'Newest first'}
    </button>
  );

  const tabs = (
    <nav className="tabs" role="tablist">
      {(['photos', 'albums', 'tags'] as Tab[]).map((t) => (
        <button key={t} role="tab" aria-selected={tab === t}
                className={`tab ${tab === t ? 'on' : ''}`}
                onClick={() => { setTab(t); setSelection(new Set()); window.scrollTo(0, 0); }}>
          {t === 'photos' ? 'Photos' : t === 'albums' ? 'Albums' : 'Tags'}
        </button>
      ))}
    </nav>
  );

  // ------------------------------------------------------- top-level shell
  if (!open) {
    return (
      <main>
        <header className="head" ref={headRef}>
          <h1>Photos</h1>
          {tabs}
          <div className="push row-gap">
            {tab !== 'albums' && sortButton}
            {tab === 'albums' && (
              <button className="btn primary small"
                      onClick={() => { setText(''); setDialog({ kind: 'newAlbum' }); }}>
                New album
              </button>
            )}
          </div>
        </header>

        {tab === 'photos' && (
          <TimelineView
            key={sort} order={sort}
            onOpen={(list, i) => setGlobalLb({ items: list, index: i })}
            selection={selection}
            onToggle={toggleIn(viewItems)}
            onItems={setViewItems}
          />
        )}

        {tab === 'tags' && (
          <TagsView
            order={sort}
            onOpen={(list, i) => setGlobalLb({ items: list, index: i })}
            selection={selection}
            onToggle={toggleIn(viewItems)}
            onItems={setViewItems}
          />
        )}

        {tab === 'albums' && (
          <>
            <p className="muted small res-count">
              {albums.length === 1 ? '1 album' : `${albums.length} albums`}
              {' · '}
              {albums.reduce((n, a) => n + a.n, 0).toLocaleString()} photos & videos
            </p>
            {!albums.length && (
              <div className="empty fade-in">
                <div className="empty-art">🌿</div>
                <h2>No albums yet</h2>
                <p className="muted">Create one, then drop some photos in.</p>
                <button className="btn primary" onClick={() => { setText(''); setDialog({ kind: 'newAlbum' }); }}>
                  Create your first album
                </button>
              </div>
            )}
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
          </>
        )}

        {globalLb && (
          <Lightbox
            items={globalLb.items as unknown as OwnerManifestItem[]}
            index={globalLb.index}
            onClose={() => setGlobalLb(null)}
            onIndex={(i) => setGlobalLb({ ...globalLb, index: i })}
            urlFor={(it, v) => assetUrl(it.id, v)}
          />
        )}

        <GlobalBar />
        {tagOpen && (
          <TagDialog mediaIds={selectedIds} onClose={() => setTagOpen(false)}
                     onDone={(m) => { notify(m); setSelection(new Set()); }} />
        )}
        {Dialogs()}
        {toast && <div className="toast">{toast}</div>}
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
          {items && items.length > 1 && sortButton}
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
        : !items.length ? (
          <div className="empty fade-in">
            <div className="empty-art">📷</div>
            <h2>Nothing here yet</h2>
            <p className="muted">Drop photos above to fill this album.</p>
          </div>
        )
        : <PhotoGrid items={shown!} onOpen={setLightbox}
                     urlFor={(it, v) => assetUrl(it.id, v)}
                     selection={selection} onToggle={toggle} />}

      {shown && lightbox !== null && (
        <Lightbox
          items={shown}
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
        onTag={() => setTagOpen(true)}
      />

      {tagOpen && (
        <TagDialog mediaIds={selectedIds} onClose={() => setTagOpen(false)}
                   onDone={(m) => { notify(m); setSelection(new Set()); }} />
      )}

      {Dialogs()}
      {toast && <div className="toast slide-up">{toast}</div>}
    </main>
  );

  /**
   * Selection toolbar for the timeline and tag views. There is no album
   * context here, so it offers tagging, adding to an album, and deleting —
   * but not "remove from album", which would be meaningless.
   */
  function GlobalBar() {
    const [target, setTarget] = useState('');
    if (!selection.size) return null;
    return (
      <div className="actionbar" role="toolbar" aria-label="Selection actions">
        <span className="ab-count">{selection.size} selected</span>
        <button className="btn small primary" onClick={() => setTagOpen(true)}>Tag</button>
        <span className="ab-sep" />
        <select className="input slim" value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">Add to album…</option>
          {(albums ?? []).map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
        </select>
        <button className="btn small" disabled={!target} onClick={() => {
          const to = target; setTarget('');
          void act(() => adminApi.addToAlbum(to, selectedIds, 'add'),
                   `Added ${selectedIds.length} to ${albums?.find((a) => a.id === to)?.title}`);
        }}>Add</button>
        <span className="ab-sep" />
        <button className="btn small danger"
                onClick={() => setDialog({ kind: 'confirmDeleteMedia', ids: selectedIds })}>Delete…</button>
        <button className="icon-btn" onClick={() => setSelection(new Set())} aria-label="Clear selection">×</button>
      </div>
    );
  }

  // Called as a function, not rendered as <Dialogs />: a component declared
  // in here has a new identity on every render, so React would remount the
  // dialog on each keystroke — replaying its animation and throwing the caret
  // to the end of the name being edited.
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
