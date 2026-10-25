import { Hono } from 'hono';
import type { Env } from './types.js';
import { accessUserEmail } from './access.js';

/**
 * Empties the whole library: every row in D1 and every object the library
 * wrote to R2. There is no undo, so it takes more than the usual admin check:
 * someone signed in through Access in a browser. ADMIN_TOKEN, or a service
 * token on some machine, is not enough to wipe everything.
 */
export const purge = new Hono<{ Bindings: Env }>({ strict: false });

export const PURGE_PHRASE = 'purge everything';

/** Everything the library writes lives under these. Other keys are left alone. */
const PREFIXES = ['orig/', 'drv/', 'post/', 'prev/', 'inbox/'];

/**
 * List-and-delete rounds per request, 1000 objects each. Small enough to stay
 * well inside a Worker's per-request limits; the page calls again until done.
 */
const ROUNDS_PER_CALL = 5;

/**
 * Children before parents, so foreign keys are never left pointing at
 * nothing mid-batch. Anything not listed here survives a purge, which the
 * Worker tests check by looking for any table that still has rows.
 */
const TABLES = [
  'runners', 'uploads', 'media_tags', 'tags', 'media_stages',
  'share_folders', 'share_links', 'album_media', 'folders', 'albums', 'media',
];

/**
 * What a purge would remove, for the confirmation screen. Any owner may read
 * it; `canPurge` says whether this caller could go on to purge.
 */
purge.get('/summary', async (c) => {
  const one = (sql: string) => c.env.DB.prepare(sql).first<{ n: number }>().then((r) => r?.n ?? 0);
  const [photos, videos, bytes, albums, shares, tags] = await Promise.all([
    one(`SELECT COUNT(*) AS n FROM media WHERE kind = 'photo'`),
    one(`SELECT COUNT(*) AS n FROM media WHERE kind = 'video'`),
    one(`SELECT COALESCE(SUM(bytes), 0) AS n FROM media`),
    one(`SELECT COUNT(*) AS n FROM albums`),
    one(`SELECT COUNT(*) AS n FROM share_links WHERE revoked = 0`),
    one(`SELECT COUNT(*) AS n FROM tags`),
  ]);
  const canPurge = Boolean(await accessUserEmail(c.req.raw, c.env));
  return c.json({ photos, videos, bytes, albums, shares, tags, phrase: PURGE_PHRASE, canPurge });
});

/**
 * One step of a purge. The first call (no `resume`) empties D1. Every call
 * then deletes up to a few thousand objects
 * and says whether any remain.
 *
 * D1 goes first: once no row refers to an object, a purge cut short leaves
 * nothing but unreferenced bytes, and running it again finishes the job.
 */
purge.post('/everything', async (c) => {
  if (!(await accessUserEmail(c.req.raw, c.env))) {
    return c.json({ error: 'purging needs you signed in through Cloudflare Access, in a browser' }, 403);
  }
  const b = await c.req.json<{ confirm?: string; resume?: boolean }>()
    .catch(() => ({} as { confirm?: string; resume?: boolean }));
  if (b.confirm !== PURGE_PHRASE) {
    return c.json({ error: `type "${PURGE_PHRASE}" to confirm` }, 400);
  }

  if (!b.resume) {
    await c.env.DB.batch(TABLES.map((t) => c.env.DB.prepare(`DELETE FROM ${t}`)));
  }

  const { deleted, done } = await deleteObjects(c.env.BUCKET, ROUNDS_PER_CALL);
  return c.json({ ok: true, deleted, done });
});

async function deleteObjects(bucket: R2Bucket, rounds: number): Promise<{ deleted: number; done: boolean }> {
  let deleted = 0;
  for (const prefix of PREFIXES) {
    for (;;) {
      // No cursor: whatever was listed is deleted, so the first page of the
      // prefix is always what is left.
      const page = await bucket.list({ prefix, limit: 1000 });
      if (!page.objects.length) break;
      // Only rounds that delete count: an empty prefix is one list call, and
      // counting it would let the prefixes alone use up a call's budget.
      if (rounds-- <= 0) return { deleted, done: false };
      await bucket.delete(page.objects.map((o) => o.key));
      deleted += page.objects.length;
      if (!page.truncated) break;
    }
  }
  return { deleted, done: true };
}
