import { Hono } from 'hono';
import { MEDIA_EXT, r2Key, type MediaRecord } from '@imagerepo/shared';
import type { Env } from './types.js';
import { r2s3 } from './s3.js';
import { insertMedia, linkToAlbum } from './db.js';

/**
 * Browser uploads, and the processing service that turns them into media.
 *
 *   browser:  /start  → presigned URLs (or "already have it")
 *             PUT the raw file straight to R2 at inbox/{id}.{ext}
 *             /finish → the file is checked for size and queued
 *             /summary → what is waiting, per album; /retry → failed ones requeued
 *   service:  /heartbeat every 20s, so the app can say whether one is running
 *             /claim  → a batch under a lease
 *             strip, resize, write orig/ drv/ post/ prev/ itself
 *             /complete → media rows, inbox copy deleted
 *             /fail     → retried after a growing wait, or given up on after MAX_ATTEMPTS
 *
 * The raw file still has its location in it, which is why it sits under
 * inbox/: no route serves that prefix, and the service deletes it once the
 * stripped original exists. The id is the browser's hash of the file; the
 * service hashes what it downloads and refuses a mismatch, so a wrong id can
 * never put the wrong bytes under an immutable key.
 */
export const inbox = new Hono<{ Bindings: Env }>({ strict: false });

const ID = /^[0-9a-f]{32}$/;
const MiB = 1024 * 1024;

/** Above this a file goes up in parts, so a dropped connection costs a part, not the file. */
const MULTIPART_FROM = 64 * MiB;
const MIN_PART = 16 * MiB;
/** ListParts returns at most 1000 parts a page; staying under that avoids paging. */
const MAX_PARTS = 1000;
const MAX_BYTES = 50 * 1024 * MiB;
/** Long enough for one large part on a slow phone connection. */
const URL_TTL = 3600;

/** Each file can cost an R2 call or two; this keeps a request well inside Worker limits. */
const FILES_PER_CALL = 25;
const PARTS_PER_CALL = 100;
/** Each record is several D1 statements and an R2 check. */
const RECORDS_PER_CALL = 20;
const MAX_ATTEMPTS = 5;
/** Seconds a failed file waits before its next attempt, so a passing outage does not use them all up. */
const BACKOFF = [60, 300, 1800, 7200];
/** An upload nobody came back to finish. R2's lifecycle rule removes its bytes too. */
const ABANDONED_AFTER = 7 * 86400;
/** A service checks in every 20s; three missed and it is reported offline. */
const ONLINE_WITHIN = 60;

const now = () => Math.floor(Date.now() / 1000);
const partSizeFor = (bytes: number) => Math.max(MIN_PART, Math.ceil(bytes / MAX_PARTS / MiB) * MiB);
const extOf = (name: string) => /\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase() ?? '';
const marks = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `?${i + from}`).join(',');

interface UploadRow {
  id: string; kind: 'photo' | 'video'; ext: string; bytes: number; orig_name: string;
  last_modified: number | null; album_id: string; folder_id: string | null;
  state: 'uploading' | 'ready' | 'claimed' | 'failed';
  multipart_id: string | null; part_size: number | null; attempts: number;
}

type StartResult =
  | { id: string; status: 'known' | 'queued' }
  | { id: string; status: 'refused'; error: string }
  | { id: string; status: 'upload'; url: string }
  | { id: string; status: 'upload'; partSize: number; partCount: number; done: number[] };

const NO_S3 = { error: 'R2 API keys are not configured on the Worker' } as const;

async function rowsById(db: D1Database, ids: string[]): Promise<Map<string, UploadRow>> {
  if (!ids.length) return new Map();
  const { results } = await db.prepare(`SELECT * FROM uploads WHERE id IN (${marks(ids.length)})`)
    .bind(...ids).all<UploadRow>();
  return new Map(results.map((r) => [r.id, r]));
}

// ------------------------------------------------------------------ browser

/**
 * Says, per file, what the browser should do: nothing ('known', 'queued'), or
 * upload with these URLs. Calling it again for the same file is how a browser
 * resumes: a large file comes back with the parts R2 already holds.
 *
 * A photo lives in one album, so a file that is in, or on its way to, another
 * album is refused with that album's name. One the library has in no album
 * (removed from its album earlier) is filed here.
 */
inbox.post('/start', async (c) => {
  const b = await c.req.json<{
    albumId?: string; folderId?: string;
    files?: { id: string; name: string; size: number; lastModified?: number }[];
  }>().catch(() => ({} as Record<string, never>));

  const files = Array.isArray(b.files) ? b.files : [];
  if (!b.albumId || !files.length) return c.json({ error: 'albumId and files required' }, 400);
  if (files.length > FILES_PER_CALL) return c.json({ error: `at most ${FILES_PER_CALL} files per call` }, 413);
  const s3 = r2s3(c.env);
  if (!s3) return c.json(NO_S3, 503);
  const db = c.env.DB;

  const album = await db.prepare('SELECT id FROM albums WHERE id = ?1').bind(b.albumId).first();
  if (!album) return c.json({ error: 'no such album' }, 404);
  let folderId: string | null = null;
  if (b.folderId) {
    const f = await db.prepare('SELECT id FROM folders WHERE id = ?1 AND album_id = ?2')
      .bind(b.folderId, b.albumId).first<{ id: string }>();
    if (!f) return c.json({ error: 'no such folder in this album' }, 404);
    folderId = f.id;
  }

  const ids = [...new Set(files.map((f) => f?.id).filter((id) => ID.test(id)))];
  // Each known id with the album it is in, or null for none.
  const known = new Map(ids.length
    ? (await db.prepare(`
        SELECT m.id, am.album_id FROM media m LEFT JOIN album_media am ON am.media_id = m.id
        WHERE m.id IN (${marks(ids.length)})
      `).bind(...ids).all<{ id: string; album_id: string | null }>()).results.map((r) => [r.id, r.album_id])
    : []);
  const pending = await rowsById(db, ids);
  const elsewhere = [...new Set([...known.values(), ...[...pending.values()].map((r) => r.album_id)])]
    .filter((a): a is string => a !== null && a !== b.albumId);
  const titles = new Map(elsewhere.length
    ? (await db.prepare(`SELECT id, title FROM albums WHERE id IN (${marks(elsewhere.length)})`)
      .bind(...elsewhere).all<{ id: string; title: string }>()).results.map((r) => [r.id, r.title])
    : []);

  const link = linkToAlbum(db);
  const links: D1PreparedStatement[] = [];
  const results: StartResult[] = [];
  const ts = now();

  for (const f of files) {
    const id = String(f?.id ?? '');
    const ext = extOf(String(f?.name ?? ''));
    const kind = MEDIA_EXT[ext];
    const size = Number(f?.size);
    if (!ID.test(id)) { results.push({ id, status: 'refused', error: 'bad id' }); continue; }
    if (!kind) { results.push({ id, status: 'refused', error: `.${ext || '?'} files are not supported` }); continue; }
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_BYTES) {
      results.push({ id, status: 'refused', error: 'bad size' }); continue;
    }

    if (known.has(id)) {
      const inAlbum = known.get(id);
      if (inAlbum && inAlbum !== b.albumId) {
        results.push({ id, status: 'refused', error: `already in “${titles.get(inAlbum)}”` }); continue;
      }
      links.push(link.bind(b.albumId, id, folderId));
      results.push({ id, status: 'known' });
      continue;
    }

    let row = pending.get(id);
    if (row && row.state !== 'failed' && row.album_id !== b.albumId) {
      results.push({ id, status: 'refused', error: `already being added to “${titles.get(row.album_id)}”` });
      continue;
    }
    // R2 expires inbox/ after 7 days whatever D1 says, so a file still waiting
    // then has to be sent again.
    const expired = !!row && (row.state === 'ready' || row.state === 'claimed') &&
      !(await c.env.BUCKET.head(r2Key.inbox(id, row.ext)));
    if (row && (row.state === 'ready' || row.state === 'claimed') && !expired) {
      results.push({ id, status: 'queued' }); continue;
    }
    if (row && row.bytes !== size) {
      results.push({ id, status: 'refused', error: 'size differs from an earlier upload of this file' });
      continue;
    }
    const key = r2Key.inbox(id, row?.ext ?? ext);

    if (!row || row.state === 'failed' || expired) {
      // A file given up on starts over: the user picking it again is the retry.
      // Only from the state it was read in, so a service finishing it meanwhile wins.
      const multipartId = size >= MULTIPART_FROM ? await s3.createMultipart(key) : null;
      const lastModified = Number.isFinite(f.lastModified) ? Math.floor(Number(f.lastModified) / 1000) : null;
      const put = await db.prepare(`
        INSERT INTO uploads (id, kind, ext, bytes, orig_name, last_modified, album_id, folder_id,
                             state, multipart_id, part_size, attempts, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'uploading', ?9, ?10, 0, ?11, ?11)
        ON CONFLICT(id) DO UPDATE SET
          state = 'uploading', multipart_id = excluded.multipart_id, part_size = excluded.part_size,
          attempts = 0, error = NULL, runner = NULL, lease_until = NULL,
          album_id = excluded.album_id, folder_id = excluded.folder_id, updated_at = excluded.updated_at
        WHERE uploads.state = ?12
      `).bind(id, kind, ext, size, String(f.name).slice(0, 255), lastModified, b.albumId, folderId,
        multipartId, multipartId ? partSizeFor(size) : null, ts, row?.state ?? 'failed').run();
      if (!put.meta?.changes) { results.push({ id, status: 'queued' }); continue; }
      row = {
        id, kind, ext, bytes: size, orig_name: f.name, last_modified: lastModified, album_id: b.albumId,
        folder_id: folderId, state: 'uploading', multipart_id: multipartId,
        part_size: multipartId ? partSizeFor(size) : null, attempts: 0,
      };
      pending.set(id, row);
    } else if (!row.multipart_id) {
      // Uploaded before, but /finish never arrived (the tab closed in between).
      const obj = await c.env.BUCKET.head(key);
      if (obj && obj.size === row.bytes) {
        await markReady(db, id);
        results.push({ id, status: 'queued' });
        continue;
      }
    }

    if (row.multipart_id && row.part_size) {
      const done = (await s3.listParts(key, row.multipart_id)).map((p) => p.partNumber);
      results.push({
        id, status: 'upload', partSize: row.part_size,
        partCount: Math.ceil(row.bytes / row.part_size), done,
      });
    } else {
      results.push({ id, status: 'upload', url: await s3.presignPut(key, URL_TTL) });
    }
  }

  if (links.length) await db.batch(links);
  return c.json({ files: results });
});

/** Presigned URLs for some parts of a large upload, asked for as the browser gets to them. */
inbox.post('/parts', async (c) => {
  const b = await c.req.json<{ id?: string; partNumbers?: number[] }>()
    .catch(() => ({} as Record<string, never>));
  const nums = Array.isArray(b.partNumbers) ? b.partNumbers : [];
  if (!ID.test(b.id ?? '') || !nums.length) return c.json({ error: 'id and partNumbers required' }, 400);
  if (nums.length > PARTS_PER_CALL) return c.json({ error: `at most ${PARTS_PER_CALL} parts per call` }, 413);
  const s3 = r2s3(c.env);
  if (!s3) return c.json(NO_S3, 503);

  const row = (await rowsById(c.env.DB, [b.id!])).get(b.id!);
  if (!row || row.state !== 'uploading' || !row.multipart_id || !row.part_size) {
    return c.json({ error: 'no multipart upload in progress for this file' }, 404);
  }
  const count = Math.ceil(row.bytes / row.part_size);
  if (nums.some((n) => !Number.isInteger(n) || n < 1 || n > count)) {
    return c.json({ error: `part numbers run from 1 to ${count}` }, 400);
  }
  const key = r2Key.inbox(row.id, row.ext);
  const urls = await Promise.all(nums.map(async (n) => ({
    partNumber: n,
    url: await s3.presignPut(key, URL_TTL, { partNumber: String(n), uploadId: row.multipart_id! }),
  })));
  return c.json({ parts: urls });
});

/**
 * The browser is done sending these files. Each is checked against the size
 * it declared at /start and queued for the service. A large file is assembled
 * from its parts here, by the Worker, so the browser never handles ETags.
 */
inbox.post('/finish', async (c) => {
  const b = await c.req.json<{ ids?: string[] }>().catch(() => ({} as { ids?: string[] }));
  const ids = [...new Set((b.ids ?? []).filter((id) => ID.test(id)))];
  if (!ids.length) return c.json({ error: 'ids required' }, 400);
  if (ids.length > FILES_PER_CALL) return c.json({ error: `at most ${FILES_PER_CALL} ids per call` }, 413);
  const db = c.env.DB;
  const rows = await rowsById(db, ids);
  const s3 = r2s3(c.env);
  if (!s3 && [...rows.values()].some((r) => r.multipart_id)) return c.json(NO_S3, 503);

  const results: { id: string; status: 'queued' | 'error'; error?: string; missing?: number[] }[] = [];
  for (const id of ids) {
    const row = rows.get(id);
    if (row && (row.state === 'ready' || row.state === 'claimed')) { results.push({ id, status: 'queued' }); continue; }
    if (!row || row.state !== 'uploading') {
      results.push({ id, status: 'error', error: 'not being uploaded; call /start first' }); continue;
    }
    const key = r2Key.inbox(id, row.ext);

    if (row.multipart_id && row.part_size) {
      const parts = await s3!.listParts(key, row.multipart_id);
      const have = new Set(parts.map((p) => p.partNumber));
      const count = Math.ceil(row.bytes / row.part_size);
      const missing = Array.from({ length: count }, (_, i) => i + 1).filter((n) => !have.has(n));
      if (missing.length) {
        results.push({ id, status: 'error', error: 'parts missing', missing: missing.slice(0, 100) });
        continue;
      }
      await s3!.completeMultipart(key, row.multipart_id,
        parts.filter((p) => p.partNumber <= count).sort((x, y) => x.partNumber - y.partNumber));
    }

    const obj = await c.env.BUCKET.head(key);
    if (!obj || obj.size !== row.bytes) {
      // Start over rather than process a truncated or padded file.
      if (obj) await c.env.BUCKET.delete(key);
      await db.prepare('DELETE FROM uploads WHERE id = ?1').bind(id).run();
      results.push({ id, status: 'error', error: obj ? 'uploaded size does not match' : 'nothing was uploaded' });
      continue;
    }
    await markReady(db, id);
    results.push({ id, status: 'queued' });
  }
  return c.json({ files: results });
});

function markReady(db: D1Database, id: string) {
  return db.prepare(`
    UPDATE uploads SET state = 'ready', multipart_id = NULL, updated_at = ?2 WHERE id = ?1
  `).bind(id, now()).run();
}

/**
 * Where uploads stand, in total and per album: the app's backlog display and
 * album badges, and the service's own logging.
 */
inbox.get('/summary', async (c) => {
  const album = c.req.query('album') ?? null;
  const { results: rows } = await c.env.DB.prepare(`
    SELECT album_id, state, COUNT(*) AS n FROM uploads WHERE (?1 IS NULL OR album_id = ?1)
    GROUP BY album_id, state
  `).bind(album).all<{ album_id: string; state: string; n: number }>();
  const counts: Record<string, number> = {};
  const albums: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    counts[r.state] = (counts[r.state] ?? 0) + r.n;
    (albums[r.album_id] ??= {})[r.state] = r.n;
  }
  const { results: failed } = await c.env.DB.prepare(`
    SELECT id, orig_name, error, attempts, updated_at FROM uploads
    WHERE state = 'failed' AND (?1 IS NULL OR album_id = ?1)
    ORDER BY updated_at DESC LIMIT 50
  `).bind(album).all();
  const ts = now();
  const { results: runners } = await c.env.DB.prepare(`
    SELECT name, kinds, busy, state, last_seen FROM runners
    WHERE last_seen > ?1 ORDER BY last_seen DESC LIMIT 10
  `).bind(ts - 7 * 86400).all<{ name: string; kinds: string; busy: number; state: string; last_seen: number }>();
  return c.json({
    counts,
    albums,
    maxAttempts: MAX_ATTEMPTS,
    failed,
    runners: runners.map((r) => ({
      name: r.name, kinds: r.kinds.split(','), busy: r.busy, lastSeen: r.last_seen,
      online: r.state === 'running' && r.last_seen > ts - ONLINE_WITHIN,
    })),
  });
});

/**
 * Puts failed uploads back in the queue with fresh attempts, without the
 * browser sending them again. Only while their bytes are still in the inbox:
 * one refused for good, or past R2's 7-day expiry, stays failed and is
 * counted as gone, and picking the file again is then the retry.
 */
inbox.post('/retry', async (c) => {
  const b = await c.req.json<{ ids?: string[] }>().catch(() => ({} as Record<string, never>));
  const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).filter((id) => ID.test(id)))];
  if (!ids.length) return c.json({ error: 'ids required' }, 400);
  if (ids.length > FILES_PER_CALL) return c.json({ error: `at most ${FILES_PER_CALL} ids per call` }, 413);
  const db = c.env.DB;

  const rows = await rowsById(db, ids);
  const retried: string[] = [];
  let gone = 0;
  for (const id of ids) {
    const row = rows.get(id);
    if (row?.state !== 'failed') continue;
    if (await c.env.BUCKET.head(r2Key.inbox(id, row.ext))) retried.push(id);
    else gone++;
  }
  if (retried.length) {
    const reset = db.prepare(`
      UPDATE uploads SET state = 'ready', attempts = 0, error = NULL, runner = NULL,
        lease_until = NULL, updated_at = ?2
      WHERE id = ?1 AND state = 'failed'
    `);
    await db.batch(retried.map((id) => reset.bind(id, now())));
  }
  return c.json({ retried: retried.length, gone });
});

// ------------------------------------------------------------------ service

/** A service saying it is alive (or, with `stopping`, that it has stopped). */
inbox.post('/heartbeat', async (c) => {
  const b = await c.req.json<{ runner?: string; kinds?: string[]; busy?: number; stopping?: boolean }>()
    .catch(() => ({} as Record<string, never>));
  const runner = String(b.runner ?? 'unknown').slice(0, 40);
  const kinds = (Array.isArray(b.kinds) ? b.kinds : []).filter((k) => k === 'photo' || k === 'video');
  const busy = Math.max(0, Math.min(Number(b.busy) || 0, 1000));
  await c.env.DB.prepare(`
    INSERT INTO runners (name, kinds, busy, state, last_seen) VALUES (?1, ?2, ?3, ?4, ?5)
    ON CONFLICT(name) DO UPDATE SET
      kinds = excluded.kinds, busy = excluded.busy, state = excluded.state, last_seen = excluded.last_seen
  `).bind(runner, kinds.join(',') || 'photo', b.stopping ? 0 : busy, b.stopping ? 'stopped' : 'running', now()).run();
  return c.json({ ok: true });
});

/**
 * Hands a batch of waiting uploads to one service instance. A single
 * statement, so two instances asking at once never get the same file; a
 * lease, so one that crashes just lets its batch lapse back into the queue.
 * `lease_until` on a waiting file is when it may next be tried (BACKOFF).
 */
inbox.post('/claim', async (c) => {
  const b = await c.req.json<{ runner?: string; limit?: number; leaseSeconds?: number; kinds?: string[] }>()
    .catch(() => ({} as Record<string, never>));
  // A service takes only what it can process: one without ffmpeg asks for photos.
  const kinds = (Array.isArray(b.kinds) ? b.kinds : ['photo', 'video']).filter((k) => k === 'photo' || k === 'video');
  if (!kinds.length) return c.json({ error: 'kinds must name photo or video' }, 400);
  const limit = Math.min(Math.max(Number(b.limit ?? 10), 1), 50);
  const lease = Math.min(Math.max(Number(b.leaseSeconds ?? 900), 60), 6 * 3600);
  const runner = String(b.runner ?? 'unknown').slice(0, 40);
  const ts = now();

  await c.env.DB.prepare(`DELETE FROM uploads WHERE state = 'uploading' AND updated_at < ?1`)
    .bind(ts - ABANDONED_AFTER).run();

  const { results } = await c.env.DB.prepare(`
    UPDATE uploads SET state = 'claimed', runner = ?1, lease_until = ?2, updated_at = ?3
    WHERE id IN (
      SELECT id FROM uploads
      WHERE state IN ('ready', 'claimed') AND COALESCE(lease_until, 0) <= ?3
        AND kind IN (${marks(kinds.length, 5)})
      ORDER BY created_at, id LIMIT ?4
    )
    RETURNING id, kind, ext, bytes, orig_name, last_modified, album_id, attempts
  `).bind(runner, ts + lease, ts, limit, ...kinds).all<{
    id: string; kind: string; ext: string; bytes: number; orig_name: string;
    last_modified: number | null; album_id: string; attempts: number;
  }>();

  return c.json({
    items: results.map((r) => ({
      id: r.id, kind: r.kind, ext: r.ext, bytes: r.bytes, key: r2Key.inbox(r.id, r.ext),
      origName: r.orig_name, lastModified: r.last_modified, albumId: r.album_id, attempts: r.attempts,
    })),
    leaseUntil: results.length ? ts + lease : null,
  });
});

/**
 * The service has written every object for these files; record them. The
 * album and folder come from the upload, not the record, so a service cannot
 * file anything anywhere the owner did not drop it.
 */
inbox.post('/complete', async (c) => {
  const b = await c.req.json<{ runner?: string; records?: MediaRecord[] }>()
    .catch(() => ({} as Record<string, never>));
  const records = (Array.isArray(b.records) ? b.records : []).filter((r) => ID.test(r?.id));
  if (!records.length) return c.json({ error: 'records required' }, 400);
  if (records.length > RECORDS_PER_CALL) return c.json({ error: `at most ${RECORDS_PER_CALL} records per call` }, 413);
  const runner = String(b.runner ?? 'preprocess').slice(0, 40);
  const db = c.env.DB;

  const rows = await rowsById(db, records.map((r) => r.id));
  const accepted: MediaRecord[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const r of records) {
    const row = rows.get(r.id);
    if (!row || row.state !== 'claimed') { skipped.push({ id: r.id, reason: 'not claimed' }); continue; }
    if (r.kind !== row.kind) { skipped.push({ id: r.id, reason: 'kind differs from the upload' }); continue; }
    if (!(await c.env.BUCKET.head(r2Key.original(r.id, r.ext)))) {
      skipped.push({ id: r.id, reason: 'original not in R2' }); continue;
    }
    accepted.push({ ...r, albums: [row.album_id], sourcePath: undefined });
  }

  if (accepted.length) {
    const folderOf = new Map(accepted.map((r) => [r.id, rows.get(r.id)!.folder_id]));
    await insertMedia(db, accepted, { folderOf, runner });
    await db.batch(accepted.map((r) => db.prepare('DELETE FROM uploads WHERE id = ?1').bind(r.id)));
    await c.env.BUCKET.delete(accepted.map((r) => r2Key.inbox(r.id, rows.get(r.id)!.ext)));
  }
  return c.json({ ok: true, recorded: accepted.length, skipped });
});

/**
 * Files the service could not process. Back in the queue, after a wait that
 * grows with each attempt, until MAX_ATTEMPTS, then 'failed'. `permanent` is for a file that can never work, such as one
 * whose bytes do not hash to its id: it fails at once and its bytes are
 * deleted, so only re-picking the file can bring it back.
 */
inbox.post('/fail', async (c) => {
  const b = await c.req.json<{ runner?: string; items?: { id: string; error?: string; permanent?: boolean }[] }>()
    .catch(() => ({} as Record<string, never>));
  const items = (Array.isArray(b.items) ? b.items : []).filter((i) => ID.test(i?.id));
  if (!items.length) return c.json({ error: 'items required' }, 400);
  if (items.length > 50) return c.json({ error: 'at most 50 items per call' }, 413);
  const runner = String(b.runner ?? 'unknown').slice(0, 40);
  const db = c.env.DB;
  const ts = now();

  const rows = await rowsById(db, items.map((i) => i.id));
  const stmt = db.prepare(`
    UPDATE uploads SET
      attempts = attempts + 1, error = ?2, runner = ?3, updated_at = ?4,
      state = CASE WHEN ?5 OR attempts + 1 >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'ready' END,
      lease_until = CASE WHEN ?5 OR attempts + 1 >= ${MAX_ATTEMPTS} THEN NULL ELSE ?6 END
    WHERE id = ?1 AND state = 'claimed'
  `);
  const wait = (id: string) => BACKOFF[Math.min(rows.get(id)?.attempts ?? 0, BACKOFF.length - 1)];
  await db.batch(items.map((i) =>
    stmt.bind(i.id, String(i.error ?? '').slice(0, 500), runner, ts, i.permanent ? 1 : 0, ts + wait(i.id))));

  const doomed = items.filter((i) => i.permanent && rows.get(i.id)?.state === 'claimed')
    .map((i) => r2Key.inbox(i.id, rows.get(i.id)!.ext));
  if (doomed.length) await c.env.BUCKET.delete(doomed);
  return c.json({ ok: true, reported: items.length });
});
