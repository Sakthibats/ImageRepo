import type { FolderSummary } from '@imagerepo/shared';

/** A cover photo: its id, and its revision for the URL. */
export type Cover = { id: string; r?: number };

/** What an album view is showing: everything, the loose photos, or one folder's id. */
export type FolderView = 'all' | 'loose' | string;

/** Items in the given view. Items arrive in album order, so the result keeps it. */
export function itemsIn<T extends { f?: string }>(items: T[], view: FolderView): T[] {
  if (view === 'all') return items;
  if (view === 'loose') return items.filter((i) => !i.f);
  return items.filter((i) => i.f === view);
}

/**
 * The row of folders above an album's grid, as pills. "All" combines every
 * folder the viewer can see; "Loose" is what sits in no folder. Without
 * folders there is no row, unless the owner can make one (`onNewFolder`).
 */
export function FolderStrip({
  folders, total, loose, view, onView, coverUrl, onNewFolder,
}: {
  folders: FolderSummary[];
  total: number;
  loose: number;
  view: FolderView;
  onView: (view: FolderView) => void;
  /** A thumbnail URL for a cover, or null if this viewer cannot load it. */
  coverUrl: (cover: Cover) => string | null;
  onNewFolder?: () => void;
}) {
  if (!folders.length && !onNewFolder) return null;
  return (
    <nav className="folders fade-in" aria-label="Folders">
      {folders.length > 0 && <>
        <Pill title="All" n={total} on={view === 'all'} onClick={() => onView('all')} />
        {(loose > 0 || view === 'loose') && (
          <Pill title="Loose" n={loose} on={view === 'loose'} onClick={() => onView('loose')}
                hint="Photos not in any folder" />
        )}
        {folders.map((f) => (
          <Pill key={f.id} title={f.title} n={f.n} on={view === f.id} onClick={() => onView(f.id)}
                img={f.cover ? coverUrl({ id: f.cover, r: f.coverRev }) : null} />
        ))}
      </>}
      {onNewFolder && <button className="folder new" onClick={onNewFolder}>+ New folder</button>}
    </nav>
  );
}

function Pill({ title, n, on, onClick, img, hint }: {
  title: string; n: number; on: boolean; onClick: () => void;
  img?: string | null; hint?: string;
}) {
  return (
    <button className={`folder ${on ? 'on' : ''}`} onClick={onClick} aria-pressed={on} title={hint ?? title}>
      {img !== undefined && (
        <span className="folder-thumb">{img && <img src={img} alt="" loading="lazy" />}</span>
      )}
      <span className="folder-name">{title}</span>
      <span className="folder-n">{n.toLocaleString()}</span>
    </button>
  );
}
