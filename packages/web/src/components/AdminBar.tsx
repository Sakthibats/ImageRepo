import { useState } from 'react';
import type { FolderSummary } from '@imagerepo/shared';
import type { AlbumSummary } from '../api.ts';
import type { FolderView } from './FolderStrip.tsx';

const LOOSE = '__loose';
const NEW = '__new';

/** Floating action bar. Appears only when something is selected. */
export function AdminBar({
  count, albums, currentAlbum, folders, view,
  onClear, onMove, onCopy, onRemove, onDelete, onSetCover, onTag, onFile, onNewFolder,
}: {
  count: number;
  albums: AlbumSummary[];
  currentAlbum: string;
  folders: FolderSummary[];
  view: FolderView;
  onClear: () => void;
  onMove: (to: string) => void;
  onCopy: (to: string) => void;
  onRemove: () => void;
  onDelete: () => void;
  /** 'album', or the id of the folder whose cover this becomes. */
  onSetCover: (target: string) => void;
  onTag: () => void;
  /** Into a folder of this album, or loose with null. */
  onFile: (folderId: string | null) => void;
  /** Make a folder, then file the selection in it. */
  onNewFolder: () => void;
}) {
  const [target, setTarget] = useState('');
  if (!count) return null;

  const others = albums.filter((a) => a.id !== currentAlbum);

  return (
    <div className="actionbar" role="toolbar" aria-label="Selection actions">
      <span className="ab-count">{count} selected</span>
      <button className="btn small primary" onClick={onTag}>Tag</button>
      <span className="ab-sep" />

      <select className="input slim" value={target} onChange={(e) => setTarget(e.target.value)}>
        <option value="">Choose album…</option>
        {others.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
      </select>
      <button className="btn small" disabled={!target} onClick={() => { onMove(target); setTarget(''); }}>Move</button>
      <button className="btn small" disabled={!target} onClick={() => { onCopy(target); setTarget(''); }}>Copy</button>

      <span className="ab-sep" />
      <select className="input slim" value="" aria-label="Move to folder"
              onChange={(e) => {
                const v = e.target.value;
                if (v === NEW) onNewFolder();
                else if (v === LOOSE) onFile(null);
                else if (v) onFile(v);
              }}>
        <option value="">Move to folder…</option>
        {folders.length > 0 && view !== 'loose' && <option value={LOOSE}>Loose (no folder)</option>}
        {folders.filter((f) => f.id !== view).map((f) => <option key={f.id} value={f.id}>{f.title}</option>)}
        <option value={NEW}>New folder…</option>
      </select>

      <span className="ab-sep" />
      {count === 1 && !folders.length && (
        <button className="btn small" onClick={() => onSetCover('album')}>Set as cover</button>
      )}
      {count === 1 && folders.length > 0 && (
        // Any photo in the album can be a folder's cover, not only its own.
        <select className="input slim" value="" aria-label="Set as cover"
                onChange={(e) => { if (e.target.value) onSetCover(e.target.value); }}>
          <option value="">Set as cover…</option>
          <option value="album">Album cover</option>
          {folders.map((f) => <option key={f.id} value={f.id}>Cover of “{f.title}”</option>)}
        </select>
      )}
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
