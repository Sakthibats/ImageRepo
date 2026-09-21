import { useEffect, useMemo, useRef, useState } from 'react';
import type { ManifestItem } from '@imagerepo/shared';
import { justify } from '../layout.ts';
import { assetUrl, pickWidth } from '../api.ts';
import { thumbhashUrl } from '../thumbhash.ts';

const OVERSCAN = 800;   // px of off-screen rows to keep mounted

export function PhotoGrid({
  items, onOpen,
}: { items: ManifestItem[]; onOpen: (index: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const onScroll = () => setScrollTop(window.scrollY);
    const onResize = () => setViewportH(window.innerHeight);
    onResize();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  const { rows, totalHeight } = useMemo(
    () => (width ? justify(items, width) : { rows: [], totalHeight: 0 }),
    [items, width],
  );

  // Index each row's position in the flat item list so the lightbox can open
  // at the right photo.
  const rowStartIndex = useMemo(() => {
    const out: number[] = [];
    let n = 0;
    for (const r of rows) { out.push(n); n += r.items.length; }
    return out;
  }, [rows]);

  const gridTop = ref.current?.offsetTop ?? 0;
  const visible = rows
    .map((row, i) => ({ row, i }))
    .filter(({ row }) => {
      const top = gridTop + row.top;
      return top + row.height >= scrollTop - OVERSCAN && top <= scrollTop + viewportH + OVERSCAN;
    });

  return (
    <div ref={ref} className="grid" style={{ height: totalHeight }}>
      {visible.map(({ row, i }) =>
        row.items.map((laid, j) => (
          <Tile
            key={laid.item.id}
            item={laid.item}
            width={laid.width}
            height={laid.height}
            left={laid.left}
            top={row.top}
            onClick={() => onOpen(rowStartIndex[i] + j)}
          />
        )),
      )}
    </div>
  );
}

function Tile({
  item, width, height, left, top, onClick,
}: {
  item: ManifestItem; width: number; height: number;
  left: number; top: number; onClick: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const placeholder = thumbhashUrl(item.th);
  const variant = pickWidth(width);

  return (
    <button
      className="tile"
      style={{ width, height, left, top }}
      onClick={onClick}
      aria-label={item.k === 'video' ? 'Open video' : 'Open photo'}
    >
      {placeholder && (
        <img className="tile-ph" src={placeholder} alt="" aria-hidden="true"
             style={{ opacity: loaded ? 0 : 1 }} />
      )}
      <img
        className="tile-img"
        src={assetUrl(item.id, String(variant))}
        width={width}
        height={height}
        loading="lazy"
        decoding="async"
        alt=""
        onLoad={() => setLoaded(true)}
        style={{ opacity: loaded ? 1 : 0 }}
      />
      {item.k === 'video' && (
        <span className="tile-badge">{formatDuration(item.d)}</span>
      )}
    </button>
  );
}

export function formatDuration(ms?: number): string {
  if (!ms) return '▶';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
