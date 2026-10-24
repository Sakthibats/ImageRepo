import { useEffect, useState } from 'react';
import { adminApi, type PurgeSummary } from '../admin.ts';

const fmtBytes = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(0)} MB` : `${Math.round(n / 1e3)} KB`;

type Phase =
  | { kind: 'idle' }
  | { kind: 'running'; deleted: number }
  | { kind: 'failed'; deleted: number; error: string }
  | { kind: 'done'; deleted: number };

/** Library facts, and the one irreversible action the app offers. */
export function SettingsView({ onPurged }: { onPurged: () => void }) {
  const [summary, setSummary] = useState<PurgeSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  useEffect(() => {
    adminApi.purgeSummary().then(setSummary).catch((e) => setError((e as Error).message));
  }, []);

  const phrase = summary?.phrase ?? 'purge everything';

  /** Steps until the server says nothing is left. `resume` skips the D1 wipe. */
  const run = async (resume: boolean, already = 0) => {
    let deleted = already;
    setPhase({ kind: 'running', deleted });
    try {
      for (let first = !resume; ; first = false) {
        const r = await adminApi.purgeStep(phrase, !first);
        deleted += r.deleted;
        setPhase({ kind: 'running', deleted });
        if (r.done) break;
      }
      setPhase({ kind: 'done', deleted });
      setTyped('');
      setSummary(await adminApi.purgeSummary().catch(() => null));
      onPurged();
    } catch (e) {
      setPhase({ kind: 'failed', deleted, error: (e as Error).message });
    }
  };

  const items = summary ? summary.photos + summary.videos : 0;

  return (
    <div className="settings fade-in">
      <section className="card">
        <h2>Library</h2>
        {error ? <p className="err">{error}</p>
          : !summary ? <p className="muted small">Loading…</p>
          : (
            <dl className="stats">
              <div><dt>Photos</dt><dd>{summary.photos.toLocaleString()}</dd></div>
              <div><dt>Videos</dt><dd>{summary.videos.toLocaleString()}</dd></div>
              <div><dt>Albums</dt><dd>{summary.albums.toLocaleString()}</dd></div>
              <div><dt>Active share links</dt><dd>{summary.shares.toLocaleString()}</dd></div>
              <div><dt>Tags</dt><dd>{summary.tags.toLocaleString()}</dd></div>
              <div><dt>Originals</dt><dd>{fmtBytes(summary.bytes)}</dd></div>
            </dl>
          )}
      </section>

      <section className="card danger-zone">
        <h2>Danger zone</h2>
        <h3>Purge everything</h3>
        <p className="muted">
          Permanently deletes every photo and video, every generated size, all
          albums, folders, tags and share links. Share links stop working at
          once. There is no undo. The files on your computer are not touched.
        </p>
        {phase.kind === 'running' && (
          <div className="purge-progress" role="status">
            <div className="bar"><div className="bar-fill indeterminate" /></div>
            <span className="muted small">Deleting… {phase.deleted.toLocaleString()} files removed from storage</span>
          </div>
        )}
        {phase.kind === 'done' && (
          <p className="ok-note" role="status">
            Your library is empty. {phase.deleted.toLocaleString()} files were removed from storage.
          </p>
        )}
        {phase.kind === 'failed' && (
          <div className="purge-progress">
            <p className="err">
              Stopped after {phase.deleted.toLocaleString()} files: {phase.error}.
              Your albums are already gone; finishing removes the remaining files.
            </p>
            <button className="btn danger small" onClick={() => void run(true, phase.deleted)}>Finish purging</button>
          </div>
        )}

        {summary && !summary.canPurge && phase.kind === 'idle' && (
          <p className="err">
            Purging is only possible when you are signed in through Cloudflare Access
            in a browser, on the hostname Access protects.
          </p>
        )}

        {phase.kind !== 'running' && phase.kind !== 'failed' && summary?.canPurge && (
          <div className="purge-confirm">
            <label className="field">
              <span>Type <code>{phrase}</code> to confirm</span>
              <input className="input" value={typed} autoComplete="off" spellCheck={false}
                     onChange={(e) => setTyped(e.target.value)} />
            </label>
            <button className="btn primary danger" disabled={typed.trim() !== phrase}
                    onClick={() => void run(false)}>
              {items ? `Purge ${items.toLocaleString()} items` : 'Purge everything'}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
