import { Hono } from 'hono';
import type { Env } from './types.js';

export const slugTag = (s: string) =>
  s.normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 48);

const now = () => Math.floor(Date.now() / 1000);

/* ------------------------------------------------------------------ owner
   Read routes. Mounted under /a, which already resolves the viewer, so these
   are owner-only — a share guest never reaches them and tags are therefore
   never exposed to viewers.                                                */

export const tagReads = new Hono<{ Bindings: Env }>({ strict: false });

/** Every tag with how many items carry it. Drives the Tags tab. */
tagReads.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(`
    SELECT t.id, t.name, COUNT(mt.media_id) AS n
    FROM tags t LEFT JOIN media_tags mt ON mt.tag_id = t.id
    GROUP BY t.id
    ORDER BY n DESC, t.name
  `).all();
  return c.json({ tags: results });
});

/** media_id -> tag ids, for the items currently on screen. */
tagReads.get('/map', async (c) => {
  const album = c.req.query('album');
  const rows = album
    ? await c.env.DB.prepare(`
        SELECT mt.media_id, mt.tag_id FROM media_tags mt
        JOIN album_media am ON am.media_id = mt.media_id
        WHERE am.album_id = ?1
      `).bind(album).all()
    : await c.env.DB.prepare(`SELECT media_id, tag_id FROM media_tags`).all();

  const map: Record<string, string[]> = {};
  for (const r of rows.results as { media_id: string; tag_id: string }[]) {
    (map[r.media_id] ??= []).push(r.tag_id);
  }
  return c.json({ map });
});

/* ------------------------------------------------------------------ admin */

export const tagWrites = new Hono<{ Bindings: Env }>({ strict: false });

/** Bulk apply and remove in one call — what the selection toolbar needs. */
tagWrites.post('/apply', async (c) => {
  const b = await c.req.json<{ mediaIds?: string[]; add?: string[]; remove?: string[] }>()
    .catch(() => ({} as Record<string, never>));

  const mediaIds = (b.mediaIds ?? []).filter((x) => /^[0-9a-f]{32}$/.test(x));
  const add = (b.add ?? []).map((t) => ({ id: slugTag(t), name: t.trim() })).filter((t) => t.id);
  const remove = (b.remove ?? []).map(slugTag).filter(Boolean);

  if (!mediaIds.length) return c.json({ error: 'mediaIds required' }, 400);
  if (!add.length && !remove.length) return c.json({ error: 'nothing to do' }, 400);

  const ts = now();
  const stmts = [];

  if (add.length) {
    const mkTag = c.env.DB.prepare(
      `INSERT INTO tags (id, name, created_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(id) DO NOTHING`
    );
    for (const t of add) stmts.push(mkTag.bind(t.id, t.name, ts));

    const link = c.env.DB.prepare(
      `INSERT INTO media_tags (media_id, tag_id, added_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(media_id, tag_id) DO NOTHING`
    );
    for (const m of mediaIds) for (const t of add) stmts.push(link.bind(m, t.id, ts));
  }

  if (remove.length) {
    const unlink = c.env.DB.prepare(`DELETE FROM media_tags WHERE media_id = ?1 AND tag_id = ?2`);
    for (const m of mediaIds) for (const t of remove) stmts.push(unlink.bind(m, t));
  }

  await c.env.DB.batch(stmts);
  return c.json({ ok: true, media: mediaIds.length, added: add.length, removed: remove.length });
});

tagWrites.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json<{ name?: string }>().catch(() => ({} as { name?: string }));
  const name = (b.name ?? '').trim();
  if (!name) return c.json({ error: 'name required' }, 400);

  const newId = slugTag(name);
  if (!newId) return c.json({ error: 'name must contain letters or digits' }, 400);

  if (newId !== id) {
    const clash = await c.env.DB.prepare('SELECT 1 FROM tags WHERE id = ?1').bind(newId).first();
    if (clash) return c.json({ error: `a tag named "${name}" already exists` }, 409);
    // media_tags.tag_id cascades on update only if declared; do it explicitly.
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO tags (id, name, created_at) SELECT ?2, ?3, created_at FROM tags WHERE id = ?1').bind(id, newId, name),
      c.env.DB.prepare('UPDATE media_tags SET tag_id = ?2 WHERE tag_id = ?1').bind(id, newId),
      c.env.DB.prepare('DELETE FROM tags WHERE id = ?1').bind(id),
    ]);
    return c.json({ ok: true, id: newId });
  }

  await c.env.DB.prepare('UPDATE tags SET name = ?2 WHERE id = ?1').bind(id, name).run();
  return c.json({ ok: true, id });
});

tagWrites.delete('/:id', async (c) => {
  const r = await c.env.DB.prepare('DELETE FROM tags WHERE id = ?1').bind(c.req.param('id')).run();
  if (!r.meta.changes) return c.json({ error: 'no such tag' }, 404);
  return c.json({ ok: true });
});
