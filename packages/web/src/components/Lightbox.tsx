import { useEffect, useRef } from 'react';
import type { OwnerManifestItem } from '@imagerepo/shared';
import { assetUrl } from '../api.ts';
import { thumbhashUrl } from '../thumbhash.ts';

export function Lightbox({
  items, index, onClose, onIndex,
}: {
  items: OwnerManifestItem[];
  index: number;
  onClose: () => void;
  onIndex: (i: number) => void;
}) {
  const item = items[index];
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') onIndex(Math.min(index + 1, items.length - 1));
      else if (e.key === 'ArrowLeft') onIndex(Math.max(index - 1, 0));
    };
    window.addEventListener('keydown', onKey);
    // Lock background scroll while the overlay is up.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [index, items.length, onClose, onIndex]);

  // Prefetch neighbours — this is what makes paging feel instant.
  useEffect(() => {
    for (const i of [index + 1, index - 1]) {
      const n = items[i];
      if (n && n.k === 'photo') new Image().src = assetUrl(n.id, '2048');
    }
  }, [index, items]);

  if (!item) return null;

  return (
    <div className="lb" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="lb-stage" onClick={(e) => e.stopPropagation()}>
        {item.k === 'video' ? (
          <video
            key={item.id}
            className="lb-media"
            controls
            autoPlay
            playsInline
            poster={assetUrl(item.id, 'poster')}
            // The preview is H.264; the original may be HEVC and unplayable
            // outside Safari, so the browser gets the transcode first.
            src={assetUrl(item.id, 'preview')}
          />
        ) : (
          <img
            key={item.id}
            className="lb-media"
            src={assetUrl(item.id, '2048')}
            alt=""
            style={{ backgroundImage: `url(${thumbhashUrl(item.th) ?? ''})` }}
          />
        )}
      </div>

      <div className="lb-bar" onClick={(e) => e.stopPropagation()}>
        <span className="lb-meta">
          {index + 1} / {items.length}
          {item.t ? ` · ${new Date(item.t * 1000).toLocaleDateString()}` : ''}
          {item.place ? ` · ${item.place}` : ''}
        </span>
        <a className="lb-btn" href={assetUrl(item.id, 'orig')} download>Download original</a>
        <button ref={closeRef} className="lb-btn" onClick={onClose} aria-label="Close">Close</button>
      </div>

      <button className="lb-nav lb-prev" disabled={index === 0}
              onClick={(e) => { e.stopPropagation(); onIndex(index - 1); }} aria-label="Previous">‹</button>
      <button className="lb-nav lb-next" disabled={index === items.length - 1}
              onClick={(e) => { e.stopPropagation(); onIndex(index + 1); }} aria-label="Next">›</button>
    </div>
  );
}
