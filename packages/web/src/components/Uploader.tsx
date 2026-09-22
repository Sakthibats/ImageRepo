import { useCallback, useRef, useState } from 'react';
import { uploadFiles, type Progress } from '../upload.ts';

export function Uploader({ albumId, onDone }: { albumId: string; onDone: () => void }) {
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const run = useCallback(async (files: File[]) => {
    const images = files.filter((f) => /^image\/(jpeg|png|webp)$/.test(f.type));
    const rejected = files.length - images.length;
    if (!images.length) {
      setResult(rejected ? 'Only JPEG/PNG/WebP here — video goes through the CLI.' : null);
      return;
    }
    setResult(null);
    const r = await uploadFiles(images, albumId, setProgress);
    setProgress(null);
    const parts = [`${r.added} added`];
    if (r.skipped) parts.push(`${r.skipped} already present`);
    if (rejected) parts.push(`${rejected} skipped (not an image)`);
    if (r.failed.length) parts.push(`${r.failed.length} failed`);
    setResult(parts.join(' · '));
    onDone();
  }, [albumId, onDone]);

  return (
    <div
      className={`drop ${dragging ? 'over' : ''} ${progress ? 'busy' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void run([...e.dataTransfer.files]);
      }}
      onClick={() => inputRef.current?.click()}
    >
      <input
        ref={inputRef} type="file" multiple accept="image/jpeg,image/png,image/webp" hidden
        onChange={(e) => { void run([...(e.target.files ?? [])]); e.target.value = ''; }}
      />
      {progress ? (
        <>
          <div className="drop-title">
            {progress.phase === 'saving' ? 'Saving…' : `${progress.file} · ${progress.phase}`}
          </div>
          <div className="bar"><div className="bar-fill"
            style={{ width: `${(progress.done / Math.max(progress.total, 1)) * 100}%` }} /></div>
          <div className="muted small">{progress.done} / {progress.total}</div>
        </>
      ) : (
        <>
          <div className="drop-title">Drop photos here, or click to choose</div>
          <div className="muted small">
            {result ?? 'Resized in your browser before upload · video goes through the CLI'}
          </div>
        </>
      )}
    </div>
  );
}
