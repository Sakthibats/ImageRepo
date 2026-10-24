import type { FolderSummary } from '@imagerepo/shared';

/** What an album view is showing: everything, the loose photos, or one folder's id. */
export type FolderView = 'all' | 'loose' | string;

/** Items in the given view. Items arrive in album order, so the result keeps it. */
export function itemsIn<T extends { f?: string }>(items: T[], view: FolderView): T[] {
  if (view === 'all') return items;
  if (view === 'loose') return items.filter((i) => !i.f);
  return items.filter((i) => i.f === view);
}

/**
 * The row of folders above an album's grid. "All photos" combines every
 * folder the viewer can see; "Loose photos" is what sits in no folder. An
 * album without folders shows no strip at all, so it looks as it always has.
 */
export function FolderStrip({
  folders, total, loose, view, onView, coverUrl, allCover,
}: {
  folders: FolderSummary[];
  total: number;
  loose: number;
  view: FolderView;
  onView: (view: FolderView) => void;
  /** A thumbnail URL for a media id, or null if this viewer cannot load it. */
  coverUrl: (id: string) => string | null;
  allCover: string | null;
}) {
  if (!folders.length) return null;
  return (
    <nav className="folders fade-in" aria-label="Folders">
      <Card title="All photos" n={total} on={view === 'all'} onClick={() => onView('all')}
            img={allCover ? coverUrl(allCover) : null} icon="▦" />
      {(loose > 0 || view === 'loose') && (
        <Card title="Loose photos" n={loose} on={view === 'loose'} onClick={() => onView('loose')}
              img={null} icon="◌" hint="Photos not in any folder" />
      )}
      {folders.map((f) => (
        <Card key={f.id} title={f.title} n={f.n} on={view === f.id} onClick={() => onView(f.id)}
              img={f.cover ? coverUrl(f.cover) : null} icon="▢" />
      ))}
    </nav>
  );
}

function Card({ title, n, on, onClick, img, icon, hint }: {
  title: string; n: number; on: boolean; onClick: () => void;
  img: string | null; icon: string; hint?: string;
}) {
  return (
    <button className={`folder ${on ? 'on' : ''}`} onClick={onClick} aria-pressed={on} title={hint ?? title}>
      <div className="folder-thumb">
        {img ? <img src={img} alt="" loading="lazy" /> : <span aria-hidden="true">{icon}</span>}
      </div>
      <div className="folder-name">{title}</div>
      <div className="folder-n">{n === 1 ? '1 item' : `${n.toLocaleString()} items`}</div>
    </button>
  );
}
