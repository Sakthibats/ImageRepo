import { useEffect, useState } from 'react';
import { adminApi, shareState, type ShareRow, type ShareScope } from '../admin.ts';
import { fetchAlbumDetail } from '../api.ts';

type FolderCount = { id: string; title: string; n: number };

const scopeValid = (s: ShareScope) => s.scope === 'all' || s.folderIds.length > 0 || s.includeLoose;

/** How a link's scope reads in the list. */
function describeScope(s: ShareRow): string {
  if (s.scope === 'all') return 'Everything';
  const parts = s.folders.map((f) => f.title);
  if (s.include_loose) parts.push('loose photos');
  return parts.length ? parts.join(', ') : 'Nothing (its folders were deleted)';
}

/**
 * Whole album, or a chosen set of folders. A folder added to the album later
 * is shared only by "Everything" links; others must have it ticked.
 */
function ScopePicker({ folders, loose, value, onChange }: {
  folders: FolderCount[]; loose: number; value: ShareScope; onChange: (s: ShareScope) => void;
}) {
  const chosen = value.scope === 'folders' ? value : null;
  const toggle = (id: string) => chosen && onChange({
    ...chosen,
    folderIds: chosen.folderIds.includes(id) ? chosen.folderIds.filter((x) => x !== id) : [...chosen.folderIds, id],
  });
  return (
    <fieldset className="scope">
      <legend>What this link shows</legend>
      <label className="field check">
        <input type="radio" checked={!chosen} onChange={() => onChange({ scope: 'all' })} />
        <span>Everything in this album <span className="muted">· including folders added later</span></span>
      </label>
      <label className="field check">
        <input type="radio" checked={Boolean(chosen)}
               onChange={() => onChange({ scope: 'folders', folderIds: [], includeLoose: false })} />
        <span>Only the folders I choose</span>
      </label>
      {chosen && (
        <div className="scope-list fade-in">
          {folders.map((f) => (
            <label key={f.id} className="field check">
              <input type="checkbox" checked={chosen.folderIds.includes(f.id)} onChange={() => toggle(f.id)} />
              <span>{f.title} <span className="muted">· {f.n}</span></span>
            </label>
          ))}
          {loose > 0 && (
            <label className="field check">
              <input type="checkbox" checked={chosen.includeLoose}
                     onChange={(e) => onChange({ ...chosen, includeLoose: e.target.checked })} />
              <span>Loose photos, not in any folder <span className="muted">· {loose}</span></span>
            </label>
          )}
          <p className="muted small">Folders you add later stay private until you tick them here.</p>
        </div>
      )}
    </fieldset>
  );
}

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
  const [scope, setScope] = useState<ShareScope>({ scope: 'all' });
  const [folders, setFolders] = useState<FolderCount[]>([]);
  const [loose, setLoose] = useState(0);
  const [editing, setEditing] = useState<{ tokenHash: string; scope: ShareScope } | null>(null);

  const load = () => adminApi.shares()
    .then((d) => setShares(d.shares.filter((s) => s.album_id === albumId)))
    .catch((e) => setError(e.message));

  useEffect(() => {
    void load();
    fetchAlbumDetail(albumId)
      .then((d) => { setFolders([...d.folders].sort((a, b) => a.title.localeCompare(b.title))); setLoose(d.loose); })
      .catch((e) => setError(e.message));
  }, [albumId]);

  const saveScope = async () => {
    if (!editing) return;
    setBusy(true); setError(null);
    try {
      await adminApi.setShareScope(editing.tokenHash, editing.scope);
      setEditing(null);
      await load();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const create = async () => {
    setBusy(true); setError(null);
    try {
      const r = await adminApi.createShare({
        albumId,
        label: label.trim() || undefined,
        expiresInDays: days ? Number(days) : undefined,
        passcode: passcode.trim() || undefined,
        allowDownload,
        ...scope,
      });
      setMinted(r.url);
      setLabel(''); setDays(''); setPasscode(''); setScope({ scope: 'all' });
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

        {folders.length > 0 && (
          <ScopePicker folders={folders} loose={loose} value={scope} onChange={setScope} />
        )}

        <div className="modal-actions">
          <button className="btn primary" onClick={create} disabled={busy || !scopeValid(scope)}>
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
                    <div className="share-scope small">Shows: {describeScope(s)}</div>
                    <div className="muted small">
                      {s.view_count} views
                      {s.has_passcode ? ' · passcode' : ''}
                      {s.allow_download ? '' : ' · no downloads'}
                      {s.expires_at ? ` · expires ${new Date(s.expires_at * 1000).toLocaleDateString()}` : ''}
                    </div>
                    {state === 'active' && (
                      <div className="row-gap share-actions">
                        {(folders.length > 0 || s.scope === 'folders') && editing?.tokenHash !== s.token_hash && (
                          <button className="btn small" onClick={() => setEditing({
                            tokenHash: s.token_hash,
                            scope: s.scope === 'all' ? { scope: 'all' }
                              : { scope: 'folders', folderIds: s.folders.map((f) => f.id), includeLoose: Boolean(s.include_loose) },
                          })}>
                            Change folders
                          </button>
                        )}
                        <button className="btn danger small"
                                onClick={async () => { await adminApi.revokeShare(s.token_hash); void load(); }}>
                          Revoke
                        </button>
                      </div>
                    )}
                    {editing?.tokenHash === s.token_hash && (
                      <div className="share-edit fade-in">
                        <ScopePicker folders={folders} loose={loose} value={editing.scope}
                                     onChange={(scope) => setEditing({ ...editing, scope })} />
                        <p className="muted small">The link stays the same; guests see the change on their next visit.</p>
                        <div className="row-gap">
                          <button className="btn primary small" disabled={busy || !scopeValid(editing.scope)}
                                  onClick={() => void saveScope()}>Save</button>
                          <button className="btn small" onClick={() => setEditing(null)}>Cancel</button>
                        </div>
                      </div>
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
