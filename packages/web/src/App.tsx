import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FolderSummary, OwnerManifestItem } from '@imagerepo/shared';
import { fetchIndex, fetchAlbum, assetUrl, type AlbumSummary } from './api.ts';
import { adminApi } from './admin.ts';
import { PhotoGrid } from './components/PhotoGrid.tsx';
import { Lightbox } from './components/Lightbox.tsx';
import { ShareView } from './components/ShareView.tsx';
import { AdminBar, Confirm } from './components/AdminBar.tsx';
import { ShareManager } from './components/ShareManager.tsx';
import { Uploader } from './components/Uploader.tsx';
import { BacklogLine, pending, useBacklog } from './components/Backlog.tsx';
import { TimelineView } from './components/TimelineView.tsx';
import { TagsView } from './components/TagsView.tsx';
import { TagDialog } from './components/TagDialog.tsx';
import { SettingsView } from './components/SettingsView.tsx';
import { FolderStrip, itemsIn, type FolderView } from './components/FolderStrip.tsx';
import { shareTokenFromPath } from './share.ts';
import { loadSort, saveSort, type Item, type SortOrder } from './tags.ts';

/** Settings has no tab of its own: it is reached from the gear, not a lens on the library. */
type Tab = 'photos' | 'albums' | 'tags' | 'settings';

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
  | { kind: 'confirmDeleteAlbum'; album: AlbumSummary }
  | { kind: 'newFolder'; fileIds: string[] }
  | { kind: 'renameFolder'; folder: FolderSummary }
  | { kind: 'confirmDeleteFolder'; folder: FolderSummary };

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
  const [folders, setFolders] = useState<FolderSummary[]>([]);
  const [view, setView] = useState<FolderView>('all');
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [lastClicked, setLastClicked] = useState<number | null>(null);
  const [dialog, setDialog] = useState<Dialog>({ kind: 'none' });
  const [text, setText] = useState('');
  const [alsoMedia, setAlsoMedia] = useState(false);
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
    if (!album?.ver) { setItems(album ? [] : null); setFolders([]); return; }
    try {
      const m = await fetchAlbum(album.id, album.ver);
      setItems(m.items);
      setFolders(m.folders ?? []);
    } catch (e) { setError((e as Error).message); }
  }, []);

  // A selection survives a reload of the same album: the backlog reloads it
  // as photos finish processing, which can be every few seconds.
  useEffect(() => { void reloadAlbum(open); }, [open, reloadAlbum]);
  useEffect(() => { setSelection(new Set()); }, [open?.id]);
  // A different album starts on All photos; a refresh of the same one stays put.
  useEffect(() => { setView('all'); }, [open?.id]);

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

  // An open album's uploads, or on the album list every album's.
  const backlog = useBacklog(Boolean(open) || tab === 'albums', open?.id, loadIndex);

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

  // A folder deleted from under the view falls back to All photos.
  const folder = folders.find((f) => f.id === view) ?? null;
  const activeView: FolderView = view === 'all' || view === 'loose' || folder ? view : 'all';
  const inView = useMemo(() => (items ? itemsIn(items, activeView) : null), [items, activeView]);

  // An album's manifest is baked oldest first; the other order is its mirror.
  const shown = useMemo(
    () => (inView && sort === 'desc' ? [...inView].reverse() : inView), [inView, sort]);

  const changeView = (v: FolderView) => {
    setView(v); setSelection(new Set()); setLastClicked(null); setLightbox(null);
  };

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
          <h1>{tab === 'settings' ? 'Settings' : 'Photos'}</h1>
          {tabs}
          <div className="push row-gap">
            {(tab === 'photos' || tab === 'tags') && sortButton}
            {tab === 'albums' && (
              <button className="btn primary small"
                      onClick={() => { setText(''); setDialog({ kind: 'newAlbum' }); }}>
                New album
              </button>
            )}
            <button className={`icon-btn gear ${tab === 'settings' ? 'on' : ''}`} title="Settings"
                    aria-label="Settings" aria-pressed={tab === 'settings'}
                    onClick={() => { setTab('settings'); setSelection(new Set()); window.scrollTo(0, 0); }}>
              ⚙
            </button>
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

        {tab === 'settings' && (
          <SettingsView onPurged={() => { setOpen(null); void loadIndex(); }} />
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
                    <div className="muted small">
                      {a.n} items
                      {pending(backlog.summary?.albums[a.id]) > 0 &&
                        ` · ${pending(backlog.summary?.albums[a.id])} to process`}
                      {(backlog.summary?.albums[a.id]?.failed ?? 0) > 0 &&
                        <span className="danger-text"> · {backlog.summary?.albums[a.id]?.failed} failed</span>}
                    </div>
                  </button>
                  <div className="album-tools">
                    <button className="icon-btn" title="Share"
                            onClick={() => setDialog({ kind: 'share', album: a })}>↗</button>
                    <button className="icon-btn" title="Rename"
                            onClick={() => { setText(a.title); setDialog({ kind: 'renameAlbum', album: a }); }}>✎</button>
                    <button className="icon-btn danger" title="Delete album"
                            onClick={() => { setAlsoMedia(false); setDialog({ kind: 'confirmDeleteAlbum', album: a }); }}>🗑</button>
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
          {inView && inView.length > 1 && sortButton}
          {inView && inView.length > 0 && (
            <button className="btn small" onClick={() =>
              setSelection((s) => s.size === inView.length ? new Set() : new Set(inView.map((i) => i.id)))}>
              {selection.size === inView.length ? 'Clear' : 'Select all'}
            </button>
          )}
          <button className="btn small" onClick={() => { setText(''); setDialog({ kind: 'newFolder', fileIds: [] }); }}>
            New folder
          </button>
          <button className="btn small" onClick={() => setDialog({ kind: 'share', album: open })}>Share</button>
        </div>
      </header>

      <BacklogLine summary={backlog.summary} onRetried={backlog.check} />

      <Uploader albumId={open.id} folder={folder ?? undefined}
                onDone={() => { void refresh(); backlog.check(); notify('Upload complete'); }} />

      {items && (
        <FolderStrip
          folders={folders} total={items.length} loose={items.filter((i) => !i.f).length}
          view={activeView} onView={changeView}
          coverUrl={(id) => assetUrl(id, '320')} allCover={open.cover}
        />
      )}

      {folder && (
        <div className="folder-bar fade-in">
          <h2>{folder.title}</h2>
          <span className="muted small">{folder.n === 1 ? '1 item' : `${folder.n} items`}</span>
          <div className="push row-gap">
            {folder.coverPinned && (
              <button className="btn small" title="Go back to the earliest photo as this folder's cover"
                      onClick={() => void act(
                        () => adminApi.updateFolder(open.id, folder.id, { coverId: null }), 'Cover reset')}>
                Reset cover
              </button>
            )}
            <button className="btn small"
                    onClick={() => { setText(folder.title); setDialog({ kind: 'renameFolder', folder }); }}>
              Rename
            </button>
            <button className="btn small danger" onClick={() => setDialog({ kind: 'confirmDeleteFolder', folder })}>
              Delete folder
            </button>
          </div>
        </div>
      )}

      {!items || !inView ? <p className="muted center">Loading…</p>
        : !items.length ? (
          <div className="empty fade-in">
            <div className="empty-art">📷</div>
            <h2>Nothing here yet</h2>
            <p className="muted">Drop photos above to fill this album.</p>
          </div>
        )
        : !inView.length ? (
          <div className="empty fade-in">
            <div className="empty-art">🗂</div>
            <h2>{activeView === 'loose' ? 'Every photo is in a folder' : 'This folder is empty'}</h2>
            <p className="muted">
              {activeView === 'loose'
                ? 'Photos added while viewing All photos arrive here, outside any folder.'
                : 'Drop photos above, or open All photos, select some, and use Move to folder.'}
            </p>
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
        folders={folders}
        view={activeView}
        onClear={() => setSelection(new Set())}
        onMove={(to) => void act(
          () => adminApi.moveToAlbum(to, selectedIds),
          `Moved ${selectedIds.length} to ${albums.find((a) => a.id === to)?.title}`)}
        onRemove={() => void act(
          () => adminApi.removeFromAlbum(open.id, selectedIds),
          `Removed ${selectedIds.length} from this album`)}
        onSetCover={(target) => void act(
          () => target === 'album'
            ? adminApi.updateAlbum(open.id, { coverId: selectedIds[0] })
            : adminApi.updateFolder(open.id, target, { coverId: selectedIds[0] }),
          target === 'album' ? 'Album cover updated'
            : `Cover of “${folders.find((f) => f.id === target)?.title}” updated`)}
        onFile={(folderId) => void act(
          () => adminApi.fileInFolder(open.id, selectedIds, folderId),
          folderId ? `Moved ${selectedIds.length} to “${folders.find((f) => f.id === folderId)?.title}”`
            : `Moved ${selectedIds.length} out of folders`)}
        onNewFolder={() => { setText(''); setDialog({ kind: 'newFolder', fileIds: selectedIds }); }}
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
   * context here, so it offers tagging, moving to an album, and deleting —
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
          <option value="">Move to album…</option>
          {(albums ?? []).map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
        </select>
        <button className="btn small" disabled={!target} onClick={() => {
          const to = target; setTarget('');
          void act(() => adminApi.moveToAlbum(to, selectedIds),
                   `Moved ${selectedIds.length} to ${albums?.find((a) => a.id === to)?.title}`);
        }}>Move</button>
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
    if ((dialog.kind === 'newFolder' || dialog.kind === 'renameFolder') && open) {
      const renaming = dialog.kind === 'renameFolder';
      const fileIds = dialog.kind === 'newFolder' ? dialog.fileIds : [];
      const albumId = open.id;
      return (
        <Confirm
          title={renaming ? 'Rename folder' : fileIds.length ? `New folder for ${fileIds.length} item${fileIds.length === 1 ? '' : 's'}` : 'New folder'}
          confirmLabel={renaming ? 'Rename' : 'Create'}
          body={
            <input className="input" autoFocus value={text} placeholder="Folder name"
                   onChange={(e) => setText(e.target.value)} />
          }
          onCancel={() => setDialog({ kind: 'none' })}
          onConfirm={() => {
            const title = text.trim();
            setDialog({ kind: 'none' });
            if (!title) return;
            void act(async () => {
              if (renaming) return adminApi.updateFolder(albumId, (dialog as { folder: FolderSummary }).folder.id, { title });
              const made = await adminApi.createFolder(albumId, title);
              if (fileIds.length) await adminApi.fileInFolder(albumId, fileIds, made.id);
            }, renaming ? 'Folder renamed'
              : fileIds.length ? `Moved ${fileIds.length} to “${title}”` : `Created “${title}”`);
          }}
        />
      );
    }
    if (dialog.kind === 'confirmDeleteFolder' && open) {
      const f = dialog.folder;
      const albumId = open.id;
      return (
        <Confirm
          title={`Delete folder “${f.title}”?`}
          danger
          confirmLabel="Delete folder"
          body={<p className="muted">
            The folder goes away. Its {f.n === 1 ? 'photo stays' : `${f.n} photos stay`} in
            the album, loose.
          </p>}
          onCancel={() => setDialog({ kind: 'none' })}
          onConfirm={() => {
            setDialog({ kind: 'none' });
            changeView('all');
            void act(() => adminApi.deleteFolder(albumId, f.id), `Deleted folder “${f.title}”`);
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
          confirmLabel={alsoMedia ? 'Delete album and photos' : 'Delete album, keep photos'}
          body={<>
            <p className="muted">
              {alsoMedia
                ? <>The album, its folders and share links go away, and its photos are
                    deleted from storage for good.</>
                : <>The album, its folders and share links go away. The {album.n} photos
                    stay in your library, in no album.</>}
            </p>
            <label className="field check">
              <input type="checkbox" checked={alsoMedia} onChange={(e) => setAlsoMedia(e.target.checked)} />
              <span>Also delete its photos permanently</span>
            </label>
          </>}
          onCancel={() => setDialog({ kind: 'none' })}
          onConfirm={() => {
            const media = alsoMedia;
            setDialog({ kind: 'none' });
            setOpen(null);
            void (async () => {
              try {
                const r = await adminApi.deleteAlbum(album.id, media);
                await refresh();
                notify(media ? `Deleted “${album.title}” and ${r.deletedMedia} photos` : `Deleted “${album.title}”`);
              } catch (e) { notify(`Failed: ${(e as Error).message}`); }
            })();
          }}
        />
      );
    }
    return null;
  }
}
