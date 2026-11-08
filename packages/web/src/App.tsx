import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AlbumDetail, AlbumSummary, FolderSummary, OwnerMediaItem } from '@imagerepo/shared';
import { fetchAlbums, fetchAlbumDetail, fetchPage, loadAll, assetUrl } from './api.ts';
import { adminApi } from './admin.ts';
import { PhotoGrid } from './components/PhotoGrid.tsx';
import { Lightbox } from './components/Lightbox.tsx';
import { ShareView } from './components/ShareView.tsx';
import { AdminBar, Confirm } from './components/AdminBar.tsx';
import { ShareManager } from './components/ShareManager.tsx';
import { DropBox, PageDrop, UploadStatus, useUploader } from './components/Uploader.tsx';
import { BacklogLine, pending, useBacklog } from './components/Backlog.tsx';
import { TimelineView } from './components/TimelineView.tsx';
import { TagsView } from './components/TagsView.tsx';
import { TagDialog } from './components/TagDialog.tsx';
import { SettingsView } from './components/SettingsView.tsx';
import { FolderStrip, itemsIn, type FolderView } from './components/FolderStrip.tsx';
import { shareTokenFromPath } from './share.ts';
import { loadSort, saveSort, type SortOrder } from './tags.ts';
import { useRoute, type Page } from './route.ts';

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

/** Sorted albums under the year of their newest photo; empty albums, last, under their own. */
function albumsByYear(albums: AlbumSummary[]) {
  const out: { label: string; albums: AlbumSummary[] }[] = [];
  for (const a of albums) {
    const label = a.newest == null ? 'Empty' : String(new Date(a.newest * 1000).getFullYear());
    if (out.at(-1)?.label !== label) out.push({ label, albums: [] });
    out.at(-1)!.albums.push(a);
  }
  return out;
}

/**
 * "Mar 12 – 14". On the album list a year heading says which year, so years
 * show only when the span crosses one; an open album asks for them always.
 */
function albumSpan(a: AlbumSummary, withYear = false): string | null {
  if (a.oldest == null || a.newest == null) return null;
  const from = new Date(a.oldest * 1000);
  const to = new Date(a.newest * 1000);
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric',
    ...(withYear || from.getFullYear() !== to.getFullYear() ? { year: 'numeric' } : {}),
  }).formatRange(from, to);
}

const count = (n: number, one: string) => `${n.toLocaleString()} ${one}${n === 1 ? '' : 's'}`;

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
  const [route, go] = useRoute();
  const tab = route.page;
  const [viewItems, setViewItems] = useState<OwnerMediaItem[]>([]);
  const [globalLb, setGlobalLb] = useState<{ items: OwnerMediaItem[]; index: number } | null>(null);
  const [tagOpen, setTagOpen] = useState(false);
  const [albums, setAlbums] = useState<AlbumSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = (route.album && albums?.find((a) => a.id === route.album)) || null;
  const [items, setItems] = useState<OwnerMediaItem[] | null>(null);
  const [detail, setDetail] = useState<AlbumDetail | null>(null);
  const [albumLoading, setAlbumLoading] = useState(false);
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
  const folders = detail?.folders ?? [];
  /** Every photo of albums opened this session, by album id. */
  const albumCache = useRef(new Map<string, OwnerMediaItem[]>());
  /** Each album load is numbered; only the latest may set state. */
  const albumLoad = useRef(0);
  /** The album a load is under way for. */
  const loadingId = useRef<string | null>(null);
  /** Whose photos `items` holds, so a refresh can keep the grid until the new copy is whole. */
  const itemsOf = useRef<string | null>(null);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2600);
  }, []);

  const loadIndex = useCallback(async (): Promise<AlbumSummary[] | null> => {
    try {
      const { albums: list } = await fetchAlbums();
      setAlbums(sortAlbums(list));
      return list;
    } catch (e) { setError((e as Error).message); return null; }
  }, []);

  useEffect(() => { void loadIndex(); }, [loadIndex]);

  /**
   * Shows an album: its folders and counts, then every page of its photos.
   * A whole copy from earlier in the session is used again while the album's
   * count still matches, so going back to an album reads no photos from D1.
   * `fresh` re-reads anyway: an edit can change an album without changing
   * its count.
   */
  const loadAlbum = useCallback(async (id: string, fresh = false) => {
    // Already on its way: a second look would only start it over.
    if (!fresh && loadingId.current === id) return;
    const n = ++albumLoad.current;
    const live = () => albumLoad.current === n;
    loadingId.current = id;
    try {
      const d = await fetchAlbumDetail(id);
      if (!live()) return;
      setDetail(d);
      const cached = albumCache.current.get(id);
      if (cached && !fresh && cached.length === d.n) { setItems(cached); itemsOf.current = id; return; }

      // A first look fills in page by page; a refresh keeps the grid as it
      // was until the new copy is whole, so it never shrinks to one page.
      const first = itemsOf.current !== id;
      if (first) { setItems(null); itemsOf.current = id; }
      setAlbumLoading(true);
      const all = await loadAll(
        (after, limit) => fetchPage({ album: id }, { after, limit }),
        (sofar) => { if (first) setItems(sofar); },
        live,
      );
      if (all) { albumCache.current.set(id, all); setItems(all); }
    } catch (e) {
      if (live()) setError((e as Error).message);
    } finally {
      if (live()) { setAlbumLoading(false); loadingId.current = null; }
    }
  }, []);

  useEffect(() => {
    if (open) { void loadAlbum(open.id); return; }
    albumLoad.current++;
    loadingId.current = null;
    itemsOf.current = null;
    setItems(null); setDetail(null); setAlbumLoading(false);
  }, [open?.id, loadAlbum]);
  // A link to an album that is gone (deleted, or mistyped) lands on the album list.
  useEffect(() => { if (albums && route.album && !open) go({ page: 'albums' }, true); }, [albums, route.album, open, go]);
  // Back and forward change pages too, so leaving one drops its selection and lightbox.
  useEffect(() => { setSelection(new Set()); setGlobalLb(null); }, [tab, open?.id]);
  // A different album starts on All photos; a refresh of the same one stays put.
  useEffect(() => { setView('all'); }, [open?.id]);

  /** After an edit: the album list, and the open album read again if it still exists. */
  const refresh = useCallback(async () => {
    albumCache.current.clear();
    const list = await loadIndex();
    if (open && list?.some((a) => a.id === open.id)) await loadAlbum(open.id, true);
    setSelection(new Set());
  }, [open, loadIndex, loadAlbum]);

  // An open album's uploads, or on the album list every album's. When the
  // number left changes, the album counts are read again (a few rows each),
  // which is what puts up the "new" prompt; the open album's photos are read
  // again once its queue is empty, not as each one finishes.
  const backlog = useBacklog(Boolean(open) || tab === 'albums', open?.id, (left) => {
    void loadIndex();
    if (open && left === 0) void loadAlbum(open.id);
  });

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

  // An album's pages come oldest first; the other order is its mirror.
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

  const up = useUploader({
    albumId: open?.id, folder: folder ?? undefined,
    // Files the library already had are filed at once; the rest arrive as they are processed.
    onDone: () => { void loadIndex(); if (open) void loadAlbum(open.id); backlog.check(); notify('Upload complete'); },
  });

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

  const sortButton = (iconOnly = false) => (
    <button className={`btn small sort ${iconOnly ? 'icon-only' : ''}`}
            title={`${sort === 'asc' ? 'Oldest' : 'Newest'} first: click for ${sort === 'asc' ? 'newest' : 'oldest'} first`}
            aria-label={sort === 'asc' ? 'Oldest first' : 'Newest first'}
            onClick={() => {
              const next: SortOrder = sort === 'asc' ? 'desc' : 'asc';
              setSort(next); saveSort(next);
              // Positions in the list change, so a range selection anchor no longer means anything.
              setLastClicked(null); setLightbox(null); setGlobalLb(null);
              window.scrollTo(0, 0);
            }}>
      <span aria-hidden="true">{sort === 'asc' ? '↑' : '↓'}</span>
      {!iconOnly && (sort === 'asc' ? 'Oldest first' : 'Newest first')}
    </button>
  );

  const tabs = (
    <nav className="tabs" role="tablist">
      {(['photos', 'albums', 'tags'] as Page[]).map((t) => (
        <button key={t} role="tab" aria-selected={tab === t}
                className={`tab ${tab === t ? 'on' : ''}`}
                onClick={() => go({ page: t })}>
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
          <img className="logo" src="/logo.svg" alt="" width="34" height="34" />
          {/* The tabs name the other pages; a heading repeating one was noise. */}
          <h1 className={tab === 'settings' ? undefined : 'sr-only'}>
            {tab === 'settings' ? 'Settings' : tab === 'photos' ? 'Photos' : tab === 'albums' ? 'Albums' : 'Tags'}
          </h1>
          {tabs}
          <div className="push row-gap">
            {(tab === 'photos' || tab === 'tags') && sortButton()}
            {tab === 'albums' && (
              <button className="btn primary small"
                      onClick={() => { setText(''); setDialog({ kind: 'newAlbum' }); }}>
                New album
              </button>
            )}
            <button className={`icon-btn gear ${tab === 'settings' ? 'on' : ''}`} title="Settings"
                    aria-label="Settings" aria-pressed={tab === 'settings'}
                    onClick={() => go({ page: 'settings' })}>
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
          <SettingsView onPurged={() => { albumCache.current.clear(); void loadIndex(); }} />
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
              {count(albums.length, 'album')} · {albums.reduce((n, a) => n + a.n, 0).toLocaleString()} photos & videos
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
            {albumsByYear(albums).map((g) => (
              <section key={g.label} className="tl-section">
                <h2 className="tl-head">
                  {g.label}
                  <span className="tl-count">{g.albums.length}</span>
                </h2>
                <div className="albums">
                  {g.albums.map((a) => (
                    <div key={a.id} className="album fade-in">
                      <button className="album-hit" onClick={() => go({ page: 'albums', album: a.id })}>
                        <div className="album-cover">
                          {a.cover
                            ? <img src={assetUrl({ id: a.cover, r: a.coverRev }, '320')}
                                   srcSet={`${assetUrl({ id: a.cover, r: a.coverRev }, '320')} 320w, ${assetUrl({ id: a.cover, r: a.coverRev }, '1024')} 1024w`}
                                   sizes="(max-width: 680px) 50vw, 480px" alt="" loading="lazy" />
                            : <div className="album-blank" />}
                        </div>
                        <div className="album-name">{a.title}</div>
                        <div className="muted small album-meta">
                          {[albumSpan(a), count(a.n, 'item'), a.folderCount > 0 && count(a.folderCount, 'folder')]
                            .filter(Boolean).join(' · ')}
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
              </section>
            ))}
          </>
        )}

        {globalLb && (
          <Lightbox
            items={globalLb.items}
            index={globalLb.index}
            onClose={() => setGlobalLb(null)}
            onIndex={(i) => setGlobalLb({ ...globalLb, index: i })}
            urlFor={assetUrl}
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
        <button className="back" onClick={() => go({ page: 'albums' })}>‹ Albums</button>
        <h1>{open.title}</h1>
        <span className="muted">
          {[albumSpan(open, true), count(open.n, 'item'), folders.length > 0 && count(folders.length, 'folder')]
            .filter(Boolean).join(' · ')}
        </span>
        <BacklogLine summary={backlog.summary} onRetried={backlog.check} />
        <div className="push row-gap">
          {inView && inView.length > 1 && sortButton(true)}
          <button className="btn small" onClick={() => setDialog({ kind: 'share', album: open })}>Share</button>
          <button className="btn small primary" onClick={up.pick} disabled={up.uploading}>
            {up.uploading ? 'Uploading…' : 'Add photos'}
          </button>
        </div>
      </header>
      {up.input}
      <PageDrop up={up} label={`Drop to add to “${folder?.title ?? open.title}”`} />
      <UploadStatus up={up} />

      {!albumLoading && items && open.n !== items.length && (
        <div className="backlog-new small">
          <button className="btn small" onClick={() => void loadAlbum(open.id)}>
            {open.n > items.length ? `${(open.n - items.length).toLocaleString()} new · Show` : 'Album changed · Show'}
          </button>
        </div>
      )}

      {items && detail && (items.length > 0 || folders.length > 0) && (
        <FolderStrip
          folders={folders} total={detail.n} loose={detail.loose}
          view={activeView} onView={changeView}
          coverUrl={(c) => assetUrl(c, '320')}
          onNewFolder={() => { setText(''); setDialog({ kind: 'newFolder', fileIds: [] }); }}
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
        : !items.length ? <DropBox up={up} title="Nothing here yet" />
        : !inView.length ? (
          <div className="empty fade-in">
            <div className="empty-art">🗂</div>
            <h2>{activeView === 'loose' ? 'Every photo is in a folder' : 'This folder is empty'}</h2>
            <p className="muted">
              {activeView === 'loose'
                ? 'Photos added while viewing All arrive here, outside any folder.'
                : 'Drop photos anywhere on this page, or open All, select some, and use Move to folder.'}
            </p>
          </div>
        )
        : <PhotoGrid items={shown!} onOpen={setLightbox}
                     urlFor={assetUrl}
                     selection={selection} onToggle={toggle} />}

      {shown && lightbox !== null && (
        <Lightbox
          items={shown}
          index={lightbox}
          onClose={() => setLightbox(null)}
          onIndex={setLightbox}
          urlFor={assetUrl}
        />
      )}

      <AdminBar
        count={selection.size}
        total={shown?.length ?? 0}
        onSelectAll={() => setSelection(new Set((shown ?? []).map((i) => i.id)))}
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
