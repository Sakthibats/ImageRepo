import { useCallback, useEffect, useRef, useState } from 'react';
import { adminApi, type InboxCounts, type InboxSummary, type Runner } from '../admin.ts';

/** Uploads the service has yet to finish: waiting for it, retrying after a failure, or being processed now. */
export const pending = (c: InboxCounts | undefined) => (c?.ready ?? 0) + (c?.retrying ?? 0) + (c?.claimed ?? 0);

const RETRY_BATCH = 25;

/**
 * The upload queue for one album, or with no album for all of them. Each
 * look reads every waiting upload's row, so it is rationed: every 30s while
 * the count moves, doubling up to 5 min while it sits still (a service
 * offline, a tab left open), and back to 30s once it moves or on `check()`.
 * An empty queue costs next to nothing and stays at 30s. `onChange` fires
 * with how many are left whenever that changes, and on the first look after
 * starting or `check()`, so counts and the open album catch up without being
 * re-read on every poll.
 */
export function useBacklog(enabled: boolean, albumId: string | undefined, onChange: (left: number) => void) {
  const [summary, setSummary] = useState<InboxSummary | null>(null);
  const [asked, setAsked] = useState(0);
  const changed = useRef(onChange);
  changed.current = onChange;

  useEffect(() => { setSummary(null); }, [enabled, albumId]);

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let last = Infinity;
    let still = 0;
    const poll = async () => {
      let next = 30_000;
      if (document.visibilityState === 'visible') {
        try {
          const s = await adminApi.inboxSummary(albumId);
          if (stopped) return;
          setSummary(s);
          const left = pending(s.counts);
          if (left !== last) changed.current(left);
          still = left && left === last ? still + 1 : 0;
          last = left;
          next = Math.min(30_000 * 2 ** still, 300_000);
        } catch { /* a blip; ask again */ }
      }
      if (!stopped) timer = setTimeout(poll, next);
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [enabled, albumId, asked]);

  /** Asks again now: after an upload or a retry. */
  const check = useCallback(() => setAsked((n) => n + 1), []);
  return { summary, check };
}

/**
 * One album's processing state, as a pill in its header: how many are left,
 * with a bar from the most this page has seen waiting, and what failed.
 * Opening it says which service is running, the breakdown, and offers a
 * retry that needs no re-upload while the files are still in storage.
 * Nothing waiting and nothing failed: no pill.
 */
export function BacklogLine({ summary, onRetried }: { summary: InboxSummary | null; onRetried: () => void }) {
  const [note, setNote] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [open, setOpen] = useState(false);
  const peak = useRef(0);
  const box = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [open]);

  if (!summary) return null;

  const waiting = summary.counts.ready ?? 0;
  const backingOff = summary.counts.retrying ?? 0;
  const processing = summary.counts.claimed ?? 0;
  const failed = summary.counts.failed ?? 0;
  const left = waiting + backingOff + processing;
  peak.current = left ? Math.max(peak.current, left) : 0;
  if (!left && !failed) return null;
  const online = summary.runners.some((r) => r.online);

  const retry = async () => {
    setRetrying(true);
    let retried = 0, gone = 0;
    try {
      const ids = summary.failed.map((f) => f.id);
      for (let i = 0; i < ids.length; i += RETRY_BATCH) {
        const r = await adminApi.inboxRetry(ids.slice(i, i + RETRY_BATCH));
        retried += r.retried; gone += r.gone;
      }
      setNote([
        retried ? `${retried} back in the queue` : '',
        gone ? `${gone} no longer in storage: pick ${gone === 1 ? 'it' : 'them'} again` : '',
      ].filter(Boolean).join(' · '));
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setRetrying(false);
      onRetried();
    }
  };

  return (
    <details className="backlog small" ref={box} open={open}
             onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className={`backlog-pill ${online ? 'ok' : 'off'}`}>
        <span className="dot" />
        {left > 0 && (online ? `Processing · ${left.toLocaleString()} left` : `Offline · ${left.toLocaleString()} waiting`)}
        {failed > 0 && <span className="danger-text">{left ? ' · ' : ''}{failed} failed</span>}
        {left > 0 && online && (
          <span className="backlog-bar" aria-hidden="true">
            <span style={{ width: `${Math.max(4, ((peak.current - left) / peak.current) * 100)}%` }} />
          </span>
        )}
      </summary>
      <div className="backlog-pop">
        <ServiceStatus runners={summary.runners} waiting={left} />
        {left > 0 && (
          <ul className="backlog-counts">
            {processing > 0 && <li>{processing} processing</li>}
            {waiting > 0 && <li>{waiting} waiting</li>}
            {backingOff > 0 && (
              <li title="These failed once and go back to the service after a pause, which grows with each attempt">
                {backingOff} retrying{summary.retryAt ? ` ${inAbout(summary.retryAt)}` : ''}
              </li>
            )}
          </ul>
        )}
        {failed > 0 && (
          <>
            <div className="danger-text">{failed} failed</div>
            <ul className="upload-problems">
              {summary.failed.map((f) => <li key={f.id}><b>{f.orig_name}</b>: {f.error}</li>)}
            </ul>
            {failed > summary.failed.length && (
              <p className="muted">Showing the latest {summary.failed.length}; retry to see the rest.</p>
            )}
            <button className="btn small" disabled={retrying} onClick={() => void retry()}>
              {retrying ? 'Retrying…' : 'Retry'}
            </button>
          </>
        )}
        {note && <p className="muted">{note}</p>}
      </div>
    </details>
  );
}

/** Whether anything will process uploads now. Uploads are accepted either way. */
function ServiceStatus({ runners, waiting }: { runners: Runner[]; waiting: number }) {
  const online = runners.filter((r) => r.online);
  if (online.length) {
    const kinds = new Set(online.flatMap((r) => r.kinds));
    const takes = kinds.has('photo') && kinds.has('video') ? 'photos and videos'
      : kinds.has('video') ? 'videos only' : 'photos only';
    return (
      <span className="service ok">
        <span className="dot" />Processing service running on {online.map((r) => r.name).join(', ')} · {takes}
      </span>
    );
  }
  // Not an error: uploads are kept until it runs, as long as R2 keeps inbox/.
  // Details stay in the tooltip.
  const last = runners[0];
  const detail = `${last ? `Last seen on ${last.name} ${ago(last.lastSeen)}. ` : ''}Start it with: python -m preprocessing run`;
  return (
    <span className="service off" title={detail}>
      <span className="dot" />
      Processing offline · {waiting ? 'these are kept for 7 days until it’s back' : 'uploads will wait up to 7 days'}
    </span>
  );
}

function inAbout(epochSeconds: number): string {
  const s = epochSeconds - Date.now() / 1000;
  if (s < 60) return 'in under a minute';
  if (s < 3600) return `in ${Math.round(s / 60)} min`;
  return `in ${Math.round(s / 3600)} h`;
}

function ago(epochSeconds: number): string {
  const s = Math.max(0, Date.now() / 1000 - epochSeconds);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}
