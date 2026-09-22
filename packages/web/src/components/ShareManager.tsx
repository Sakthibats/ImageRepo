import { useEffect, useState } from 'react';
import { adminApi, shareState, type ShareRow } from '../admin.ts';

export function ShareManager({ albumId, albumTitle, onClose }: {
  albumId: string; albumTitle: string; onClose: () => void;
}) {
  const [shares, setShares] = useState<ShareRow[] | null>(null);
  const [minted, setMinted] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // form
  const [label, setLabel] = useState('');
  const [days, setDays] = useState('');
  const [passcode, setPasscode] = useState('');
  const [allowDownload, setAllowDownload] = useState(true);

  const load = () => adminApi.shares()
    .then((d) => setShares(d.shares.filter((s) => s.album_id === albumId)))
    .catch((e) => setError(e.message));

  useEffect(() => { void load(); }, [albumId]);

  const create = async () => {
    setBusy(true); setError(null);
    try {
      const r = await adminApi.createShare({
        albumId,
        label: label.trim() || undefined,
        expiresInDays: days ? Number(days) : undefined,
        passcode: passcode.trim() || undefined,
        allowDownload,
      });
      setMinted(r.url);
      setLabel(''); setDays(''); setPasscode('');
      await load();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard blocked; the text is selectable anyway */ }
  };

  return (
    <div className="modal-wrap" onClick={onClose}>
      <div className="modal modal-lg fade-up" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Share “{albumTitle}”</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>
        </div>

        {minted && (
          <div className="minted fade-in">
            <div className="minted-label">
              Link created — copy it now, it is never shown again
            </div>
            <div className="minted-row">
              <input className="input mono" readOnly value={minted}
                     onFocus={(e) => e.currentTarget.select()} />
              <button className="btn primary" onClick={() => copy(minted)}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
        )}

        <div className="field-grid">
          <label className="field">
            <span>Label</span>
            <input className="input" value={label} placeholder="e.g. sent to mum"
                   onChange={(e) => setLabel(e.target.value)} />
          </label>
          <label className="field">
            <span>Expires after (days)</span>
            <input className="input" type="number" min="1" value={days} placeholder="never"
                   onChange={(e) => setDays(e.target.value)} />
          </label>
          <label className="field">
            <span>Passcode</span>
            <input className="input" value={passcode} placeholder="none"
                   onChange={(e) => setPasscode(e.target.value)} />
          </label>
          <label className="field check">
            <input type="checkbox" checked={allowDownload}
                   onChange={(e) => setAllowDownload(e.target.checked)} />
            <span>Allow downloading originals</span>
          </label>
        </div>

        <div className="modal-actions">
          <button className="btn primary" onClick={create} disabled={busy}>
            {busy ? 'Creating…' : 'Create link'}
          </button>
        </div>

        {error && <p className="err">{error}</p>}

        <h3 className="sub">Existing links</h3>
        {!shares ? <p className="muted small">Loading…</p>
          : !shares.length ? <p className="muted small">No links for this album yet.</p>
          : (
            <ul className="share-list">
              {shares.map((s) => {
                const state = shareState(s);
                return (
                  <li key={s.token_hash} className={`share-row ${state}`}>
                    <div>
                      <span className={`pill ${state}`}>{state}</span>
                      <span className="share-label">{s.label || '(no label)'}</span>
                    </div>
                    <div className="muted small">
                      {s.view_count} views
                      {s.has_passcode ? ' · passcode' : ''}
                      {s.allow_download ? '' : ' · no downloads'}
                      {s.expires_at ? ` · expires ${new Date(s.expires_at * 1000).toLocaleDateString()}` : ''}
                    </div>
                    {state === 'active' && (
                      <button className="btn danger small"
                              onClick={async () => { await adminApi.revokeShare(s.token_hash); void load(); }}>
                        Revoke
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
      </div>
    </div>
  );
}
