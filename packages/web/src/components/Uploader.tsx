import { useCallback, useEffect, useRef, useState } from 'react';
import { supported, uploadFiles, type UploadState } from '../upload.ts';

type Phase =
  | { kind: 'idle'; result?: string; problems?: { name: string; error: string }[] }
  | { kind: 'uploading'; state: UploadState };

/**
 * Sending picked or dropped files to an album. The state lives here; the
 * album view places the pieces: a header button (`pick`), the page-wide
 * drop target, the status card, and the big drop box of an empty album.
 */
export function useUploader({ albumId, folder, onDone }: {
  /** The open album, if any: picked files go there. */
  albumId: string | undefined;
  /** The folder being viewed, which picked files go into. */
  folder?: { id: string; title: string };
  /** Everything picked has been sent; processing is the backlog's to show. Called as it is then, wherever the owner is. */
  onDone: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  // An upload outlives leaving its album; its status shows only back in it.
  const [forAlbum, setForAlbum] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);
  const done = useRef(onDone);
  done.current = onDone;

  const uploading = phase.kind === 'uploading';

  // Leaving mid-upload loses only the file in flight (picking again resumes),
  // but say so; and keep a phone's screen on, since a locked phone stops sending.
  useEffect(() => {
    if (!uploading) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    let lock: WakeLockSentinel | undefined;
    navigator.wakeLock?.request('screen').then((l) => { lock = l; }).catch(() => {});
    return () => { window.removeEventListener('beforeunload', warn); void lock?.release(); };
  }, [uploading]);

  const run = useCallback(async (picked: File[]) => {
    if (uploading || !albumId) return;
    setForAlbum(albumId);
    const files = picked.filter(supported);
    const unsupported = picked.filter((f) => !supported(f)).map((f) => ({ name: f.name, error: 'not a supported type' }));
    if (!files.length) {
      setPhase({ kind: 'idle', result: unsupported.length ? 'None of those can be added.' : undefined, problems: unsupported });
      return;
    }

    const state = await uploadFiles(files, { albumId, folderId: folder?.id },
      (s) => setPhase({ kind: 'uploading', state: s }));

    const problems = [...state.failed, ...unsupported];
    const parts = [`${state.sent} uploaded${state.sent ? ', shown here once processed' : ''}`];
    if (state.known) parts.push(`${state.known} already in the library`);
    if (problems.length) parts.push(`${problems.length} not uploaded`);
    setPhase({ kind: 'idle', result: parts.join(' · '), problems });
    done.current();
  }, [albumId, folder?.id, uploading]);

  const input = (
    <input
      ref={inputRef} type="file" multiple hidden
      // HEIC named explicitly: with image/* alone, iOS may convert to JPEG.
      accept="image/*,video/*,.heic,.heif"
      onChange={(e) => { void run([...(e.target.files ?? [])]); e.target.value = ''; }}
    />
  );

  return {
    phase, uploading, run, input,
    here: forAlbum === albumId,
    pick: () => { if (!uploading) inputRef.current?.click(); },
    dismiss: () => { if (!uploading) setPhase({ kind: 'idle' }); },
  };
}

type Uploader = ReturnType<typeof useUploader>;

/**
 * Files dragged anywhere over the page: a full-window overlay while they
 * hover, and the drop is sent. Counting enters and leaves, because each child
 * the drag crosses fires both.
 */
export function PageDrop({ up, label }: { up: Uploader; label: string }) {
  const [over, setOver] = useState(false);
  const run = useRef(up.run);
  run.current = up.run;

  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false;
    const enter = (e: DragEvent) => { if (hasFiles(e)) { depth++; setOver(true); } };
    const leave = (e: DragEvent) => { if (hasFiles(e) && --depth <= 0) { depth = 0; setOver(false); } };
    const overFn = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault(); };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0; setOver(false);
      void run.current([...(e.dataTransfer?.files ?? [])]);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', overFn);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', overFn);
      window.removeEventListener('drop', drop);
    };
  }, []);

  if (!over) return null;
  return (
    <div className="page-drop fade-in" aria-hidden="true">
      <div className="page-drop-box">
        <div className="page-drop-icon">↓</div>
        <div className="drop-title">{up.uploading ? 'Wait for this upload to finish' : label}</div>
        <div className="muted small">Sent at full size, resized on the server</div>
      </div>
    </div>
  );
}

/** What is being sent now, or how the last batch went (until dismissed). */
export function UploadStatus({ up }: { up: Uploader }) {
  const { phase } = up;
  if (!up.here || (phase.kind === 'idle' && !phase.result)) return null;
  return (
    <div className="upload-status fade-in">
      {phase.kind === 'uploading' ? <Uploading s={phase.state} /> : (
        <>
          <div className="upload-status-row">
            <span>{phase.result}</span>
            <button className="icon-btn" aria-label="Dismiss" onClick={up.dismiss}>×</button>
          </div>
          {phase.problems && phase.problems.length > 0 && (
            <details className="small">
              <summary>What was not uploaded</summary>
              <ul className="upload-problems">
                {phase.problems.slice(0, 50).map((p, i) => <li key={i}><b>{p.name}</b>: {p.error}</li>)}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}

/** An empty album or folder: the page is the place to drop, so say so in full. */
export function DropBox({ up, title }: { up: Uploader; title: string }) {
  return (
    <button className="drop fade-in" onClick={up.pick} disabled={up.uploading}>
      <div className="empty-art">📷</div>
      <div className="drop-title">{title}</div>
      <div className="muted small">Drop photos and videos anywhere on this page, or click to choose</div>
    </button>
  );
}

function Uploading({ s }: { s: UploadState }) {
  const handled = s.sent + s.known + s.failed.length;
  const hashing = s.hashed < s.files && s.bytesSent === 0;
  return (
    <>
      <div className="drop-title">
        {hashing ? `Reading ${s.hashed} of ${s.files}…` : `Uploading ${Math.min(handled + 1, s.files)} of ${s.files}`}
      </div>
      <div className="bar"><div className="bar-fill"
        style={{ width: `${(s.bytes ? s.bytesSent / s.bytes : handled / Math.max(s.files, 1)) * 100}%` }} /></div>
      <div className="muted small">
        {size(s.bytesSent)} of {size(s.bytes)}
        {s.known ? ` · ${s.known} already in the library` : ''}
        {s.failed.length ? ` · ${s.failed.length} failed` : ''}
        {' · keep this page open'}
      </div>
    </>
  );
}

function size(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(0, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
