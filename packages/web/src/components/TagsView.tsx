import { useEffect, useState } from 'react';
import type { SortOrder } from '../tags.ts';
import type { OwnerMediaItem } from '@imagerepo/shared';
import { assetUrl, fetchPage, loadAll } from '../api.ts';
import { tagsApi, type Tag } from '../tags.ts';
import { PhotoGrid } from './PhotoGrid.tsx';
import { TagChip } from './TagChip.tsx';

/** Browse and search by tag. Selecting several narrows (AND) by default. */
export function TagsView({
  order, onOpen, selection, onToggle, onItems,
}: {
  order: SortOrder;
  onOpen: (items: OwnerMediaItem[], index: number) => void;
  selection: Set<string>;
  onToggle: (id: string, index: number, shiftKey: boolean) => void;
  onItems: (items: OwnerMediaItem[]) => void;
}) {
  const [tags, setTags] = useState<Tag[] | null>(null);
  const [active, setActive] = useState<string[]>([]);
  const [mode, setMode] = useState<'all' | 'any'>('all');
  const [results, setResults] = useState<OwnerMediaItem[] | null>(null);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void tagsApi.list().then((d) => setTags(d.tags)).catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!active.length) { setResults(null); onItems([]); return; }
    let live = true;
    setResults(null);
    void loadAll(
      (after, limit) => fetchPage({ tags: active, match: mode }, { order, after, limit }),
      (items) => { setResults(items); onItems(items); },
      () => live,
    ).catch((e) => setError(e.message));
    return () => { live = false; };
  }, [active, mode, order, onItems]);

  const toggleTag = (id: string) =>
    setActive((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);

  if (error) return <p className="err center">{error}</p>;
  if (!tags) return <p className="muted center">Loading…</p>;

  if (!tags.length) {
    return (
      <div className="empty fade-in">
        <div className="empty-art">🏷️</div>
        <h2>No tags yet</h2>
        <p className="muted">Select photos anywhere, then use Tag on the toolbar.</p>
      </div>
    );
  }

  const shown = filter.trim()
    ? tags.filter((t) => t.name.toLowerCase().includes(filter.trim().toLowerCase()))
    : tags;

  return (
    <>
      <div className="tag-bar">
        <input className="input" value={filter} placeholder="Filter tags…"
               onChange={(e) => setFilter(e.target.value)} />
        {active.length > 1 && (
          <div className="seg">
            <button className={mode === 'all' ? 'on' : ''} onClick={() => setMode('all')}>All of</button>
            <button className={mode === 'any' ? 'on' : ''} onClick={() => setMode('any')}>Any of</button>
          </div>
        )}
        {active.length > 0 && (
          <button className="btn small" onClick={() => setActive([])}>Clear</button>
        )}
      </div>

      <div className="chip-row tag-cloud">
        {shown.map((t) => (
          <TagChip key={t.id} id={t.id} name={t.name} count={t.n}
                   active={active.includes(t.id)} onClick={() => toggleTag(t.id)} />
        ))}
      </div>

      {!active.length ? (
        <p className="muted center small">Pick a tag to see its photos.</p>
      ) : !results ? (
        <p className="muted center">Searching…</p>
      ) : !results.length ? (
        <div className="empty fade-in">
          <div className="empty-art">🔍</div>
          <h2>No matches</h2>
          <p className="muted">
            {mode === 'all' && active.length > 1
              ? 'Nothing carries all of those tags — try “Any of”.'
              : 'Nothing carries that tag yet.'}
          </p>
        </div>
      ) : (
        <>
          <p className="muted small res-count">
            {results.length} {results.length === 1 ? 'item' : 'items'}
          </p>
          <PhotoGrid
            items={results}
            onOpen={(i) => onOpen(results, i)}
            urlFor={assetUrl}
            selection={selection}
            onToggle={onToggle}
          />
        </>
      )}
    </>
  );
}
