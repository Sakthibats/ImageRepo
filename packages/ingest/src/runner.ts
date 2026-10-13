import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import pLimit from 'p-limit';
import type { MediaRecord } from '@imagerepo/shared';
import { r2Key } from '@imagerepo/shared';
import { hashFile } from './hash.js';
import type { IngestState, FileRow } from './state.js';
import { STAGES, buildRecord, recordKey, type PipelineOptions, type StageInput } from './stages/index.js';

/** The parts of R2 and the Worker API the runner needs — small enough to fake in tests. */
export interface Storage {
  exists(key: string): Promise<boolean>;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
}
export interface Recorder {
  readonly configured: boolean;
  recordMedia(records: MediaRecord[]): Promise<unknown>;
}

/**
 *  added      processed, uploaded and recorded
 *  updated    already in the library; a new or changed stage was run for it
 *  linked     the bytes were already uploaded; only the record was (re)sent,
 *             e.g. the same photo filed under another album
 *  unchanged  nothing to do
 *  held       uploaded, but the Worker could not be reached to record it
 *  removed    uploaded once, then deleted from the library (in the web app);
 *             left alone unless `restore` is set
 *  failed     see `error`
 */
export type Outcome = 'added' | 'updated' | 'linked' | 'unchanged' | 'held' | 'removed' | 'failed';

export interface FileResult {
  path: string; album: string; outcome: Outcome; error?: string;
}
export interface RunResult {
  files: FileResult[];
  uploadedBytes: number;
  counts: Record<Outcome, number>;
}
export interface Progress {
  done: number; total: number; failed: number; uploadedBytes: number; current: string;
}
export interface RunDeps {
  state: IngestState;
  storage: Storage | null;
  recorder: Recorder | null;
  opts: PipelineOptions;
  concurrency?: number;
  /** Send records only; never start processing. Used by `flush`. */
  recordOnly?: boolean;
  /** Re-upload items that were deleted from the library since this computer added them. */
  restore?: boolean;
  /** Called once, with the albums about to receive records, before any are sent. */
  beforeRecord?: (albums: string[]) => Promise<void>;
  onProgress?: (p: Progress) => void;
}

const RECORD_BATCH = 200;
/**
 * A record is several database statements, and Workers cap how many one
 * request may run (far lower on the free plan). If a full batch is refused,
 * it is re-sent in pieces this small before giving up.
 */
const RECORD_BATCH_SMALL = 8;

async function sendRecords(recorder: Recorder, records: MediaRecord[]): Promise<void> {
  try {
    await recorder.recordMedia(records);
  } catch (e) {
    if (records.length <= RECORD_BATCH_SMALL) throw e;
    // Re-sending a record is harmless, so a batch that half-landed is fine.
    for (let i = 0; i < records.length; i += RECORD_BATCH_SMALL) {
      await recorder.recordMedia(records.slice(i, i + RECORD_BATCH_SMALL));
    }
  }
}

class StageError extends Error {
  constructor(stage: string, cause: unknown) {
    super(`${stage}: ${String((cause as Error)?.message ?? cause).split('\n')[0]}`);
  }
}

/**
 * Brings each file up to date: runs whichever stages are missing for its
 * content, then makes sure the database record matches.
 *
 * Nothing here decides "is this file finished" from a status flag. It asks,
 * per stage, whether a result exists at the current version. That is what
 * makes a run resumable at the granularity of a stage, lets a new stage or a
 * version bump create its own backlog, and means a dry run — which saves no
 * results — can never be mistaken for a real one.
 */
export async function runFiles(files: FileRow[], deps: RunDeps): Promise<RunResult> {
  const { state, storage, recorder, opts } = deps;
  const dry = Boolean(opts.dryRun);
  const runs = state.runs();
  const limit = pLimit(deps.concurrency ?? 4);

  const results: FileResult[] = [];
  const toRecord: { row: FileRow; record: MediaRecord; key: string; outcome: Outcome }[] = [];
  let uploadedBytes = 0;
  let failed = 0;

  /** Two paths with identical bytes share one run of the stages. */
  const inflight = new Map<string, Promise<Record<string, unknown>>>();

  /**
   * The ledger remembers an upload forever, but the library does not have to:
   * deleting an item in the web app removes its objects. Before doing anything
   * more for bytes uploaded in an earlier run, confirm they are still there —
   * otherwise a record would resurrect a photo the owner deleted, pointing at
   * files that no longer exist. Asked once per content hash.
   */
  const deletedChecks = new Map<string, Promise<boolean>>();
  function deletedSince(hash: string): Promise<boolean> {
    let check = deletedChecks.get(hash);
    if (!check) {
      check = (async () => {
        const original = runs.get(hash)?.get('original');
        const ext = (original?.data as { ext?: string } | null)?.ext;
        if (dry || !storage || original?.state !== 'done' || !ext) return false;
        if (await storage.exists(r2Key.original(hash, ext))) return false;
        if (deps.restore) {
          // Forget the old results so every stage runs, and uploads, again.
          state.clearRuns(hash);
          runs.delete(hash);
          return false;
        }
        return true;
      })();
      deletedChecks.set(hash, check);
    }
    return check;
  }

  async function content(
    row: FileRow, hash: string,
  ): Promise<{ data: Record<string, unknown>; ran: 'all' | 'some' | 'none' }> {
    const shared = inflight.get(hash);
    if (shared) return { data: await shared, ran: 'none' };

    let ran: 'all' | 'some' | 'none' = 'none';
    const work = (async () => {
      const ext = extname(row.path).toLowerCase().slice(1);
      const data: Record<string, unknown> = {};
      let bytes: Promise<Buffer> | undefined;

      const input: StageInput = {
        path: row.path, hash, kind: row.kind, ext, opts,
        bytes: () => (bytes ??= readFile(row.path)),
        data: <T>(stage: string) => data[stage] as T,
        put: async (key, body, contentType) => {
          if (!dry && storage) {
            if (await storage.exists(key)) return;   // content-addressed: already there
            await storage.put(key, body, contentType);
          }
          uploadedBytes += body.length;
        },
      };

      for (const stage of STAGES[row.kind]) {
        const prior = runs.get(hash)?.get(stage.name);
        if (prior?.state === 'done' && prior.version === stage.version) {
          data[stage.name] = prior.data;
          continue;
        }
        if (deps.recordOnly) throw new StageError(stage.name, 'not processed yet');
        // Running `original` means the bytes are going up for the first time.
        if (stage.name === 'original') ran = 'all';
        else if (ran === 'none') ran = 'some';
        try {
          data[stage.name] = await stage.run(input);
        } catch (e) {
          if (!dry) state.failRun(hash, stage.name, stage.version, String((e as Error)?.message ?? e));
          throw new StageError(stage.name, e);
        }
        if (!dry) state.saveRun(hash, stage.name, stage.version, data[stage.name]);
      }
      return data;
    })();

    inflight.set(hash, work);
    return { data: await work, ran };
  }

  let done = 0;
  await Promise.all(files.map((row) => limit(async () => {
    try {
      let hash = row.hash;
      if (!hash) {
        hash = await hashFile(row.path);
        state.setHash(row.path, hash);
      }
      const key = recordKey(row.kind, row.album);
      const upToDate = row.recordedKey === key && STAGES[row.kind].every((s) => {
        const run = runs.get(hash)?.get(s.name);
        return run?.state === 'done' && run.version === s.version;
      });
      if (upToDate) {
        results.push({ path: row.path, album: row.album, outcome: 'unchanged' });
      } else if (await deletedSince(hash)) {
        results.push({ path: row.path, album: row.album, outcome: 'removed' });
      } else {
        const { data, ran } = await content(row, hash);
        toRecord.push({
          row, key, outcome: ran === 'all' ? 'added' : ran === 'some' ? 'updated' : 'linked',
          record: buildRecord({ ...row, hash }, data),
        });
      }
      if (!dry && row.error) state.setError(row.path, null);
    } catch (e) {
      failed++;
      const error = String((e as Error)?.message ?? e).split('\n')[0].slice(0, 500);
      // A StageError is already in stage_runs; anything else (an unreadable
      // file, say) happened before a hash existed and belongs to the path.
      if (!dry && !(e instanceof StageError)) state.setError(row.path, error);
      if (!dry) state.setStatus(row.path, 'failed');
      results.push({ path: row.path, album: row.album, outcome: 'failed', error });
    }
    done++;
    deps.onProgress?.({ done, total: files.length, failed, uploadedBytes, current: row.path });
  })));

  // Only albums that are actually getting something are touched — an album
  // whose every item turned out to be deleted must not be re-created empty.
  let unprepared: string | undefined;
  if (!dry && recorder?.configured && toRecord.length && deps.beforeRecord) {
    try { await deps.beforeRecord([...new Set(toRecord.map((t) => t.row.album))]); }
    catch (e) { unprepared = String((e as Error)?.message ?? e).split('\n')[0].slice(0, 300); }
  }

  // Records go last and in batches: 13,000 photos are a few dozen requests.
  for (let i = 0; i < toRecord.length; i += RECORD_BATCH) {
    const chunk = toRecord.slice(i, i + RECORD_BATCH);
    let held = unprepared;
    if (held) {
      // The albums could not be prepared; keep the uploads and try later.
    } else if (dry) {
      // Report what would happen; send and remember nothing.
    } else if (!recorder?.configured) {
      held = 'Worker not configured';
    } else {
      try {
        await sendRecords(recorder, chunk.map((c) => c.record));
      } catch (e) {
        held = String((e as Error)?.message ?? e).split('\n')[0].slice(0, 300);
      }
    }
    for (const c of chunk) {
      if (held) {
        state.setStatus(c.row.path, 'uploaded');
        results.push({ path: c.row.path, album: c.row.album, outcome: 'held', error: held });
        continue;
      }
      if (!dry) {
        state.setRecorded(c.row.path, c.key);
        state.setStatus(c.row.path, 'recorded');
      }
      results.push({ path: c.row.path, album: c.row.album, outcome: c.outcome });
    }
  }

  const counts: Record<Outcome, number> = { added: 0, updated: 0, linked: 0, unchanged: 0, held: 0, removed: 0, failed: 0 };
  for (const r of results) counts[r.outcome]++;
  return { files: results, uploadedBytes, counts };
}
