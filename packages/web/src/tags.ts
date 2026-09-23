export interface Tag { id: string; name: string; n: number }

/**
 * Deterministic hue from the tag's own name: the same label is always the same
 * colour, everywhere, without anyone picking one. Colour then carries meaning
 * rather than decorating.
 */
export function hueFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 7;
}

export const tagsApi = {
  list: () => get<{ tags: Tag[] }>('/a/tags'),
  map: (album?: string) => get<{ map: Record<string, string[]> }>(
    album ? `/a/tags/map?album=${encodeURIComponent(album)}` : '/a/tags/map'),
  timeline: (before?: number, limit = 400) => get<TimelinePage>(
    `/a/tags/timeline?limit=${limit}${before ? `&before=${before}` : ''}`),
  search: (tagIds: string[], mode: 'all' | 'any') => get<{ items: Item[] }>(
    `/a/tags/search?tags=${tagIds.map(encodeURIComponent).join(',')}&mode=${mode}`),

  apply: (mediaIds: string[], add: string[], remove: string[] = []) =>
    send('/admin/tags/apply', 'POST', { mediaIds, add, remove }),
  rename: (id: string, name: string) => send(`/admin/tags/${id}`, 'PATCH', { name }),
  remove: (id: string) => send(`/admin/tags/${id}`, 'DELETE'),
};

export interface Item {
  id: string; k: 'photo' | 'video'; w: number; h: number;
  t?: number; th?: string; d?: number; c?: string;
}
export interface TimelinePage { items: Item[]; next: number | null; total: number }

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

async function send(path: string, method: string, body?: unknown) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(d.error ?? `${res.status}`);
  }
  return res.json();
}

/** Groups timeline items into month buckets, preserving order. */
export function groupByMonth(items: Item[]): { key: string; label: string; items: Item[] }[] {
  const out: { key: string; label: string; items: Item[] }[] = [];
  let cur: { key: string; label: string; items: Item[] } | null = null;
  const thisYear = new Date().getFullYear();

  for (const it of items) {
    const d = it.t ? new Date(it.t * 1000) : null;
    const key = d ? `${d.getFullYear()}-${d.getMonth()}` : 'undated';
    if (!cur || cur.key !== key) {
      cur = {
        key,
        label: d
          ? d.toLocaleDateString(undefined, {
              month: 'long',
              ...(d.getFullYear() === thisYear ? {} : { year: 'numeric' }),
            })
          : 'Undated',
        items: [],
      };
      out.push(cur);
    }
    cur.items.push(it);
  }
  return out;
}
