import { useState } from 'react';
import type { AlbumSummary } from '../api.ts';

/** Floating action bar. Appears only when something is selected. */
export function AdminBar({
  count, albums, currentAlbum, onClear, onMove, onCopy, onRemove, onDelete, onSetCover,
}: {
  count: number;
  albums: AlbumSummary[];
  currentAlbum: string;
  onClear: () => void;
  onMove: (to: string) => void;
  onCopy: (to: string) => void;
  onRemove: () => void;
  onDelete: () => void;
  onSetCover: () => void;
}) {
  const [target, setTarget] = useState('');
  if (!count) return null;

  const others = albums.filter((a) => a.id !== currentAlbum);

  return (
    <div className="actionbar slide-up" role="toolbar" aria-label="Selection actions">
      <span className="ab-count">{count} selected</span>

      <select className="input slim" value={target} onChange={(e) => setTarget(e.target.value)}>
        <option value="">Choose album…</option>
        {others.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
      </select>
      <button className="btn small" disabled={!target} onClick={() => { onMove(target); setTarget(''); }}>Move</button>
      <button className="btn small" disabled={!target} onClick={() => { onCopy(target); setTarget(''); }}>Copy</button>

      <span className="ab-sep" />
      {count === 1 && <button className="btn small" onClick={onSetCover}>Set as cover</button>}
      <button className="btn small" onClick={onRemove}>Remove from album</button>
      <button className="btn small danger" onClick={onDelete}>Delete…</button>
      <button className="icon-btn" onClick={onClear} aria-label="Clear selection">×</button>
    </div>
  );
}

/** Confirm dialog for anything destructive. */
export function Confirm({
  title, body, confirmLabel, danger, onConfirm, onCancel,
}: {
  title: string; body: React.ReactNode; confirmLabel: string;
  danger?: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <div className="modal-wrap" onClick={onCancel}>
      <div className="modal fade-up" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2>{title}</h2></div>
        <div className="modal-body">{body}</div>
        <div className="modal-actions">
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
