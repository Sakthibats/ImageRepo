import { useEffect, useRef } from 'react';
import type { OwnerManifestItem } from '@imagerepo/shared';
import type { UrlFor } from './PhotoGrid.tsx';
import { thumbhashUrl } from '../thumbhash.ts';

export function Lightbox({
  items, index, onClose, onIndex, urlFor, allowDownload = true,
}: {
  items: OwnerManifestItem[];
  index: number;
  onClose: () => void;
  onIndex: (i: number) => void;
  urlFor: UrlFor;
  allowDownload?: boolean;
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
    // Lock background scroll while the overlay is up. Pinning the body to a
    // negative offset keeps the page from jumping to the top, which is what
    // overflow:hidden alone does on iOS — and restores the exact position on
    // close, so closing the lightbox leaves you where you were in the grid.
    const scrollY = window.scrollY;
    const { body } = document;
    const prev = { position: body.style.position, top: body.style.top, width: body.style.width, overflow: body.style.overflow };
    body.style.position = 'fixed';
    body.style.top = `-${scrollY}px`;
    body.style.width = '100%';
    body.style.overflow = 'hidden';
    closeRef.current?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      Object.assign(body.style, prev);
      window.scrollTo(0, scrollY);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') onIndex(Math.min(index + 1, items.length - 1));
      else if (e.key === 'ArrowLeft') onIndex(Math.max(index - 1, 0));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, items.length, onClose, onIndex]);

  // Prefetch neighbours — this is what makes paging feel instant.
  useEffect(() => {
    for (const i of [index + 1, index - 1]) {
      const n = items[i];
      if (n && n.k === 'photo') new Image().src = urlFor(n, '2048');
    }
  }, [index, items, urlFor]);

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
            poster={urlFor(item, 'poster')}
            // The preview is H.264; the original may be HEVC and unplayable
            // outside Safari, so the browser gets the transcode first.
            src={urlFor(item, 'preview')}
          />
        ) : (
          <img
            key={item.id}
            className="lb-media"
            src={urlFor(item, '2048')}
            alt=""
            style={{ backgroundImage: `url(${thumbhashUrl(item.th) ?? ''})` }}
          />
        )}
      </div>

      <div className="lb-bar" onClick={(e) => e.stopPropagation()}>
        <span className="lb-meta">
          {index + 1} / {items.length}
          {item.t ? ` · ${new Date(item.t * 1000).toLocaleDateString(undefined,
            { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}
          {item.place ? ` · ${item.place}` : ''}
        </span>
        {allowDownload && (
          <a className="lb-btn" href={urlFor(item, 'orig')} download>Download original</a>
        )}
        <button ref={closeRef} className="lb-btn" onClick={onClose} aria-label="Close">Close</button>
      </div>

      <button className="lb-nav lb-prev" disabled={index === 0}
              onClick={(e) => { e.stopPropagation(); onIndex(index - 1); }} aria-label="Previous">‹</button>
      <button className="lb-nav lb-next" disabled={index === items.length - 1}
              onClick={(e) => { e.stopPropagation(); onIndex(index + 1); }} aria-label="Next">›</button>
    </div>
  );
}
