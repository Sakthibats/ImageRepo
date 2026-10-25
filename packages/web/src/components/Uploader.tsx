import { useCallback, useEffect, useRef, useState } from 'react';
import { adminApi, type Runner } from '../admin.ts';
import { supported, uploadFiles, watchProcessing, type UploadState } from '../upload.ts';

type Phase =
  | { kind: 'idle'; result?: string; problems?: { name: string; error: string }[] }
  | { kind: 'uploading'; state: UploadState }
  | { kind: 'processing'; left: number; total: number; upload: UploadState };

export function Uploader({ albumId, folder, onProgress, onDone }: {
  albumId: string;
  /** The folder being viewed, which picked files go into. */
  folder?: { id: string; title: string };
  /** Some files have been processed and can be shown. */
  onProgress: () => void;
  onDone: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const inputRef = useRef<HTMLInputElement>(null);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);

  const busy = phase.kind !== 'idle';
  const uploading = phase.kind === 'uploading';

  // Whether a processing service is running: checked on open and every 30s
  // while idle; the processing phase gets it from its own polling.
  const [runners, setRunners] = useState<Runner[] | null>(null);
  useEffect(() => {
    if (phase.kind === 'processing') return;
    let stopped = false;
    const check = () => {
      if (document.visibilityState !== 'visible') return;
      adminApi.inboxSummary(albumId).then((s) => { if (!stopped) setRunners(s.runners); }).catch(() => {});
    };
    check();
    const t = setInterval(check, 30_000);
    return () => { stopped = true; clearInterval(t); };
  }, [albumId, phase.kind]);

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
    const files = picked.filter(supported);
    const unsupported = picked.filter((f) => !supported(f)).map((f) => ({ name: f.name, error: 'not a supported type' }));
    if (!files.length) {
      setPhase({ kind: 'idle', result: unsupported.length ? 'None of those can be added.' : undefined, problems: unsupported });
      return;
    }

    const { state, queued } = await uploadFiles(files, { albumId, folderId: folder?.id },
      (s) => live.current && setPhase({ kind: 'uploading', state: s }));
    if (state.known) onProgress();

    let seen = Infinity;
    let failedProcessing: { name: string; error: string }[] = [];
    if (state.sent) {
      setPhase({ kind: 'processing', left: state.sent, total: state.sent, upload: state });
      await watchProcessing(albumId, (left, { failed, runners }) => {
        if (!live.current) return;
        setRunners(runners);
        if (left < seen && seen !== Infinity) onProgress();
        seen = left;
        // The summary covers the whole album; keep to this upload's files.
        const mine = new Set(queued);
        failedProcessing = failed.filter((f) => mine.has(f.id)).map((f) => ({ name: f.orig_name, error: f.error }));
        setPhase({ kind: 'processing', left, total: Math.max(state.sent, left), upload: state });
      }, () => !live.current);
    }
    if (!live.current) return;

    const problems = [...state.failed, ...failedProcessing, ...unsupported];
    const added = state.sent - failedProcessing.length;
    const parts = [`${added} added`];
    if (state.known) parts.push(`${state.known} already in the library`);
    if (problems.length) parts.push(`${problems.length} not added`);
    setPhase({ kind: 'idle', result: parts.join(' · '), problems });
    onDone();
  }, [albumId, folder?.id, onProgress, onDone]);

  return (
    <div
      className={`drop ${dragging ? 'over' : ''} ${busy ? 'busy' : ''}`}
      onDragOver={(e) => { e.preventDefault(); if (!busy) setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (!busy) void run([...e.dataTransfer.files]);
      }}
      onClick={() => { if (!busy) inputRef.current?.click(); }}
    >
      <input
        ref={inputRef} type="file" multiple hidden
        // HEIC named explicitly: with image/* alone, iOS may convert to JPEG.
        accept="image/*,video/*,.heic,.heif"
        onChange={(e) => { void run([...(e.target.files ?? [])]); e.target.value = ''; }}
      />
      {phase.kind === 'uploading' && <Uploading s={phase.state} />}
      {phase.kind === 'processing' && (
        <>
          <div className="drop-title">
            {phase.left ? `Processing ${phase.left} of ${phase.total}…` : 'Finishing…'}
          </div>
          <div className="bar"><div className="bar-fill"
            style={{ width: `${((phase.total - phase.left) / Math.max(phase.total, 1)) * 100}%` }} /></div>
          <div className="muted small">Uploaded. Photos appear as they are ready; this page can be closed.</div>
          <ServiceStatus runners={runners} waiting />
        </>
      )}
      {phase.kind === 'idle' && (
        <>
          <div className="drop-title">
            Add photos and videos{folder ? ` to “${folder.title}”` : ''}
          </div>
          <div className="muted small">
            {phase.result ?? 'Drop them here or click to choose · sent at full size, resized on the server'}
          </div>
          <ServiceStatus runners={runners} />
          {phase.problems && phase.problems.length > 0 && (
            <details className="small" onClick={(e) => e.stopPropagation()}>
              <summary>What was not added</summary>
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

/**
 * Whether anything will process an upload now. Uploads are accepted either
 * way; they wait in storage until a service runs.
 */
function ServiceStatus({ runners, waiting }: { runners: Runner[] | null; waiting?: boolean }) {
  if (!runners) return null;
  const online = runners.filter((r) => r.online);
  if (online.length) {
    const kinds = new Set(online.flatMap((r) => r.kinds));
    const takes = kinds.has('photo') && kinds.has('video') ? 'photos and videos'
      : kinds.has('video') ? 'videos only' : 'photos only';
    return (
      <div className="service ok small">
        <span className="dot" />Processing service running on {online.map((r) => r.name).join(', ')} · {takes}
      </div>
    );
  }
  // Not an error: uploads are kept until it runs. Details stay in the tooltip.
  const last = runners[0];
  const detail = `${last ? `Last seen on ${last.name} ${ago(last.lastSeen)}. ` : ''}Start it with: python -m preprocessing run`;
  return (
    <div className="service off small" title={detail}>
      <span className="dot" />
      Processing offline · {waiting ? 'these will be processed when it’s back' : 'uploads will wait'}
    </div>
  );
}

function ago(epochSeconds: number): string {
  const s = Math.max(0, Date.now() / 1000 - epochSeconds);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
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
