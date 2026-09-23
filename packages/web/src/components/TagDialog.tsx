import { useEffect, useMemo, useState } from 'react';
import { tagsApi, type Tag } from '../tags.ts';
import { TagChip } from './TagChip.tsx';

/**
 * Bulk tagging for the current selection. Shows which tags every selected item
 * already carries versus only some, so applying to a mixed selection is a
 * deliberate act rather than a surprise.
 */
export function TagDialog({
  mediaIds, onClose, onDone,
}: { mediaIds: string[]; onClose: () => void; onDone: (msg: string) => void }) {
  const [all, setAll] = useState<Tag[] | null>(null);
  const [current, setCurrent] = useState<Record<string, string[]>>({});
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([tagsApi.list(), tagsApi.map()])
      .then(([t, m]) => { setAll(t.tags); setCurrent(m.map); })
      .catch((e) => setError(e.message));
  }, []);

  const { onAll, onSome } = useMemo(() => {
    const counts = new Map<string, number>();
    for (const id of mediaIds) for (const t of current[id] ?? []) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return {
      onAll: [...counts].filter(([, n]) => n === mediaIds.length).map(([t]) => t),
      onSome: [...counts].filter(([, n]) => n < mediaIds.length).map(([t]) => t),
    };
  }, [mediaIds, current]);

  const apply = async (add: string[], remove: string[] = []) => {
    setBusy(true); setError(null);
    try {
      await tagsApi.apply(mediaIds, add, remove);
      const m = await tagsApi.map();
      setCurrent(m.map);
      setAll((await tagsApi.list()).tags);
      setDraft('');
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const nameOf = (id: string) => all?.find((t) => t.id === id)?.name ?? id;

  return (
    <div className="modal-wrap" onClick={onClose}>
      <div className="modal fade-up" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Tag {mediaIds.length} item{mediaIds.length === 1 ? '' : 's'}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>
        </div>

        <form className="tag-add" onSubmit={(e) => {
          e.preventDefault();
          const names = draft.split(',').map((x) => x.trim()).filter(Boolean);
          if (names.length) void apply(names);
        }}>
          <input className="input" value={draft} autoFocus disabled={busy}
                 placeholder="New tag — comma separated for several"
                 onChange={(e) => setDraft(e.target.value)} />
          <button className="btn primary" type="submit" disabled={busy || !draft.trim()}>Add</button>
        </form>

        {onAll.length > 0 && (
          <>
            <h3 className="sub">On all selected</h3>
            <div className="chip-row">
              {onAll.map((id) => (
                <TagChip key={id} id={id} name={nameOf(id)}
                         onRemove={() => void apply([], [id])} />
              ))}
            </div>
          </>
        )}

        {onSome.length > 0 && (
          <>
            <h3 className="sub">On some — click to apply to all</h3>
            <div className="chip-row">
              {onSome.map((id) => (
                <TagChip key={id} id={id} name={nameOf(id)}
                         onClick={() => void apply([nameOf(id)])}
                         onRemove={() => void apply([], [id])} />
              ))}
            </div>
          </>
        )}

        {all && all.length > 0 && (
          <>
            <h3 className="sub">All tags</h3>
            <div className="chip-row">
              {all.filter((t) => !onAll.includes(t.id)).map((t) => (
                <TagChip key={t.id} id={t.id} name={t.name} count={t.n}
                         onClick={() => void apply([t.name])} />
              ))}
            </div>
          </>
        )}

        {error && <p className="err">{error}</p>}

        <div className="modal-actions">
          <button className="btn" onClick={() => { onDone('Tags updated'); onClose(); }}>Done</button>
        </div>
      </div>
    </div>
  );
}
