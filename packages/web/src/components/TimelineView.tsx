import { useCallback, useEffect, useRef, useState } from 'react';
import type { ManifestItem } from '@imagerepo/shared';
import { assetUrl } from '../api.ts';
import { tagsApi, groupByMonth, type Item } from '../tags.ts';
import { PhotoGrid } from './PhotoGrid.tsx';

/**
 * The whole library by date, newest first — the default way in.
 *
 * Pages are fetched on scroll rather than all at once: at 13k items a single
 * response would be megabytes of JSON parsed before anything renders.
 */
export function TimelineView({
  onOpen, selection, onToggle, onItems,
}: {
  onOpen: (items: Item[], index: number) => void;
  selection: Set<string>;
  onToggle: (id: string, index: number, shiftKey: boolean) => void;
  onItems: (items: Item[]) => void;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);

  const loadPage = useCallback(async (before?: number) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const page = await tagsApi.timeline(before);
      setItems((prev) => {
        const merged = before ? [...prev, ...page.items] : page.items;
        onItems(merged);
        return merged;
      });
      setNext(page.next);
    } catch (e) { setError((e as Error).message); }
    setLoading(false);
    loadingRef.current = false;
  }, [onItems]);

  useEffect(() => { void loadPage(); }, [loadPage]);

  useEffect(() => {
    if (!next || !sentinel.current) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) void loadPage(next);
    }, { rootMargin: '900px' });
    io.observe(sentinel.current);
    return () => io.disconnect();
  }, [next, loadPage]);

  if (error) return <p className="err center">{error}</p>;
  if (loading) return <p className="muted center">Loading…</p>;
  if (!items.length) {
    return (
      <div className="empty fade-in">
        <div className="empty-art">🗓️</div>
        <h2>Nothing here yet</h2>
        <p className="muted">Photos will appear here newest first, grouped by month.</p>
      </div>
    );
  }

  const groups = groupByMonth(items);
  let offset = 0;

  return (
    <>
      {groups.map((g) => {
        const base = offset;
        offset += g.items.length;
        return (
          <section key={g.key} className="tl-section">
            <h2 className="tl-head">
              {g.label}
              <span className="tl-count">{g.items.length}</span>
            </h2>
            <PhotoGrid
              items={g.items as unknown as ManifestItem[]}
              onOpen={(i) => onOpen(items, base + i)}
              urlFor={(it, v) => assetUrl(it.id, v)}
              selection={selection}
              onToggle={(id, i, shift) => onToggle(id, base + i, shift)}
            />
          </section>
        );
      })}
      {next && <div ref={sentinel} className="tl-more muted small">Loading more…</div>}
    </>
  );
}
