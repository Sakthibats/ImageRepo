import { createSHA256 } from 'hash-wasm';
import { MEDIA_EXT } from '@imagerepo/shared';
import { adminApi, type InboxFile, type InboxStart } from './admin.ts';

/**
 * Browser uploads. Files go to R2 exactly as picked, straight from the
 * browser through presigned URLs; the processing service (Preprocessing/)
 * strips, resizes and records them. Nothing heavy runs here, so a phone only
 * hashes and sends.
 *
 *   hash (2 at a time) → /start in batches (the first as soon as one file is
 *   hashed) → PUT to R2 (6 at a time) → /finish
 *
 * Large files go up in parts. Picking the same files again after the page
 * closed carries on where it stopped: /start says which parts R2 already has.
 */

const HASHES_AT_ONCE = 2;
const PUTS_AT_ONCE = 6;
const START_BATCH = 25;
/** Presigned URLs last an hour, so they are asked for only a little ahead of use. */
const AHEAD = 12;
const PART_URLS_AT_ONCE = 20;
const TRIES = 4;
const MiB = 1024 * 1024;
/** Hashed in pieces above this: crypto.subtle needs the whole file in memory. */
const WHOLE_HASH_MAX = 32 * MiB;

export const extOf = (name: string) => /\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase() ?? '';
export const supported = (f: File) => Boolean(MEDIA_EXT[extOf(f.name)]);

export interface UploadState {
  /** Files being uploaded, after unsupported ones and duplicates are dropped. */
  files: number;
  hashed: number;
  /** In R2 and queued for processing. */
  sent: number;
  /** Already in the library; filed into this album instead. */
  known: number;
  bytes: number;
  bytesSent: number;
  failed: { name: string; error: string }[];
  done: boolean;
}

export interface Api {
  start: typeof adminApi.inboxStart;
  parts: typeof adminApi.inboxParts;
  finish: typeof adminApi.inboxFinish;
}

/** Sends one body to a presigned URL, reporting bytes sent so far. */
export type Put = (url: string, body: Blob, onBytes: (sent: number) => void) => Promise<void>;

const defaultApi: Api = {
  start: adminApi.inboxStart, parts: adminApi.inboxParts,
  finish: adminApi.inboxFinish,
};

export async function uploadFiles(
  files: File[],
  target: { albumId: string; folderId?: string },
  onState: (s: UploadState) => void,
  deps: { api?: Api; put?: Put } = {},
): Promise<UploadState> {
  const api = deps.api ?? defaultApi;
  const put = deps.put ?? xhrPut;
  const state: UploadState = {
    files: files.length, hashed: 0, sent: 0, known: 0,
    bytes: files.reduce((n, f) => n + f.size, 0), bytesSent: 0, failed: [], done: false,
  };
  const emit = throttled(() => onState({ ...state, failed: [...state.failed] }), 150);
  const changed = new Signal();
  const fail = (file: File, e: unknown) => {
    state.failed.push({ name: file.name, error: e instanceof Error ? e.message : String(e) });
    state.bytes -= file.size;
    emit();
  };
  const notSending = (file: File) => { state.bytes -= file.size; };
  const asInbox = (file: File, id: string): InboxFile =>
    ({ id, name: file.name, size: file.size, lastModified: file.lastModified });
  const restart = async (file: File, id: string) =>
    (await retry(() => api.start(target.albumId, [asInbox(file, id)], target.folderId))).files[0];

  // ---------------------------------------------------------------- hash
  const hashed: { file: File; id: string }[] = [];
  const seen = new Set<string>();
  let hashing = true;
  let next = 0;
  void Promise.all(Array.from({ length: HASHES_AT_ONCE }, async () => {
    while (next < files.length) {
      const file = files[next++];
      try {
        const id = await hashFile(file);
        if (seen.has(id)) {
          state.files--;                    // the same file picked twice
          notSending(file);
        } else {
          seen.add(id);
          hashed.push({ file, id });
        }
      } catch (e) {
        fail(file, e);
      }
      state.hashed++;
      emit();
      changed.notify();
    }
  })).then(() => { hashing = false; changed.notify(); });

  // ---------------------------------------------------------------- send
  const limit = limiter(PUTS_AT_ONCE);

  async function sendWhole(file: File, id: string, url: string): Promise<boolean> {
    for (let attempt = 1; ; attempt++) {
      let sent = 0;
      try {
        await limit(() => put(url, file, (n) => { state.bytesSent += n - sent; sent = n; emit(); }));
        return true;
      } catch (e) {
        state.bytesSent -= sent;
        if (attempt >= TRIES) throw e;
        await sleep(1000 * 2 ** attempt);
        // The URL may have expired while it waited; ask again.
        const again = await restart(file, id);
        if (again.status === 'known' || again.status === 'queued') return false;
        if (again.status !== 'upload' || !('url' in again)) throw new Error('could not restart the upload');
        url = again.url;
      }
    }
  }

  async function sendParts(file: File, id: string, partSize: number, partCount: number, done: number[]) {
    const slice = (n: number) => file.slice((n - 1) * partSize, Math.min(file.size, n * partSize));
    const have = new Set(done);
    for (const n of have) state.bytesSent += slice(n).size;
    const missing = Array.from({ length: partCount }, (_, i) => i + 1).filter((n) => !have.has(n));

    for (let i = 0; i < missing.length; i += PART_URLS_AT_ONCE) {
      const { parts } = await retry(() => api.parts(id, missing.slice(i, i + PART_URLS_AT_ONCE)));
      await Promise.all(parts.map(async ({ partNumber, url }) => {
        for (let attempt = 1; ; attempt++) {
          let sent = 0;
          try {
            await limit(() => put(url, slice(partNumber), (n) => { state.bytesSent += n - sent; sent = n; emit(); }));
            return;
          } catch (e) {
            state.bytesSent -= sent;
            if (attempt >= TRIES) throw e;
            await sleep(1000 * 2 ** attempt);
            url = (await retry(() => api.parts(id, [partNumber]))).parts[0].url;
          }
        }
      }));
    }
  }

  // Files whose bytes are all in R2, told to the Worker in batches.
  const finishing = new Map<string, File>();
  let finishTimer: ReturnType<typeof setTimeout> | undefined;
  let finishes = Promise.resolve();
  const flushFinish = () => {
    clearTimeout(finishTimer);
    const batch = [...finishing].slice(0, START_BATCH);
    for (const [id] of batch) finishing.delete(id);
    if (!batch.length) return finishes;
    finishes = finishes.then(async () => {
      try {
        const { files: results } = await retry(() => api.finish(batch.map(([id]) => id)));
        const byId = new Map(results.map((r) => [r.id, r]));
        for (const [id, file] of batch) {
          const r = byId.get(id);
          if (r?.status === 'queued') state.sent++;
          else if (r?.error === 'parts missing') fail(file, 'some parts did not arrive; pick it again to resume');
          else fail(file, r?.error ?? 'not confirmed');
        }
      } catch (e) {
        for (const [, file] of batch) fail(file, e);
      }
      emit();
    });
    if (finishing.size) return flushFinish();
    return finishes;
  };
  const finished = (id: string, file: File) => {
    finishing.set(id, file);
    if (finishing.size >= START_BATCH) void flushFinish();
    else { clearTimeout(finishTimer); finishTimer = setTimeout(() => void flushFinish(), 800); }
  };

  const uploads: Promise<void>[] = [];
  let inHand = 0;
  while (hashing || hashed.length) {
    // A full batch; or, while nothing is going up, whatever is hashed so far,
    // so the first files are on their way, and in the service's queue, while
    // the rest still hash. Only while few enough are in hand that their URLs
    // will not go stale waiting.
    const batchReady = hashed.length >= START_BATCH || (hashed.length > 0 && (!hashing || inHand === 0));
    if (!batchReady || inHand >= AHEAD) {
      await changed.wait();
      continue;
    }
    const batch = hashed.splice(0, START_BATCH);
    let results: InboxStart[];
    try {
      results = (await retry(() => api.start(target.albumId, batch.map((b) => asInbox(b.file, b.id)), target.folderId))).files;
    } catch (e) {
      for (const b of batch) fail(b.file, e);
      continue;
    }
    const byId = new Map(results.map((r) => [r.id, r]));
    for (const { file, id } of batch) {
      const r = byId.get(id);
      if (!r) { fail(file, 'no answer from the server'); continue; }
      if (r.status === 'known') { state.known++; notSending(file); continue; }
      if (r.status === 'queued') { state.sent++; notSending(file); continue; }
      if (r.status === 'refused') { fail(file, r.error); continue; }
      if (r.status !== 'upload') continue;
      const up = r;

      inHand++;
      uploads.push((async () => {
        try {
          const sent = 'url' in up
            ? await sendWhole(file, id, up.url)
            : (await sendParts(file, id, up.partSize, up.partCount, up.done), true);
          if (sent) finished(id, file);
          else state.sent++;
        } catch (e) {
          fail(file, e);
        } finally {
          inHand--;
          changed.notify();
          emit();
        }
      })());
    }
    emit();
  }

  await Promise.all(uploads);
  await flushFinish();
  state.done = true;
  emit.now();
  return state;
}

export async function hashFile(file: Blob): Promise<string> {
  let hex: string;
  if (file.size <= WHOLE_HASH_MAX) {
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } else {
    const h = await createSHA256();
    h.init();
    for (let at = 0; at < file.size; at += 8 * MiB) {
      h.update(new Uint8Array(await file.slice(at, at + 8 * MiB).arrayBuffer()));
    }
    hex = h.digest('hex');
  }
  return hex.slice(0, 32);
}

/** A PUT with upload progress, which fetch cannot report. */
const xhrPut: Put = (url, body, onBytes) => new Promise((resolve, reject) => {
  const x = new XMLHttpRequest();
  x.open('PUT', url);
  x.upload.onprogress = (e) => onBytes(e.loaded);
  x.onload = () => (x.status >= 200 && x.status < 300 ? resolve() : reject(new Error(`storage answered ${x.status}`)));
  x.onerror = () => reject(new Error('network error'));
  x.ontimeout = () => reject(new Error('timed out'));
  x.send(body);
});

// ---------------------------------------------------------------- helpers

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function retry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await fn(); }
    catch (e) { if (attempt >= tries) throw e; await sleep(800 * 2 ** attempt); }
  }
}

/** Runs at most n of the given tasks at once. */
function limiter(n: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((r) => waiting.push(r));
    active++;
    try { return await task(); }
    finally { active--; waiting.shift()?.(); }
  };
}

/** Lets a loop sleep until something it is waiting on changes. */
class Signal {
  private waiters: (() => void)[] = [];
  wait() { return new Promise<void>((r) => this.waiters.push(r)); }
  notify() { const w = this.waiters; this.waiters = []; w.forEach((r) => r()); }
}

function throttled(fn: () => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const call = () => { if (!timer) timer = setTimeout(() => { timer = undefined; fn(); }, ms); };
  call.now = () => { clearTimeout(timer); timer = undefined; fn(); };
  return call;
}
