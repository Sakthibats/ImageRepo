import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import pLimit from 'p-limit';
import type { MediaRecord } from '@imagerepo/shared';
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
 *  linked     the bytes were already uploaded; only the record was (re)sent,
 *             e.g. the same photo filed under another album
 *  unchanged  nothing to do
 *  held       uploaded, but the Worker could not be reached to record it
 *  failed     see `error`
 */
export type Outcome = 'added' | 'linked' | 'unchanged' | 'held' | 'failed';

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
  onProgress?: (p: Progress) => void;
}

const RECORD_BATCH = 200;

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

  async function content(row: FileRow, hash: string): Promise<{ data: Record<string, unknown>; ran: boolean }> {
    const shared = inflight.get(hash);
    if (shared) return { data: await shared, ran: false };

    let ran = false;
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
        ran = true;
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
      const { data, ran } = await content(row, hash);
      const key = recordKey(row.kind, row.album);

      if (!ran && row.recordedKey === key) {
        results.push({ path: row.path, album: row.album, outcome: 'unchanged' });
      } else {
        toRecord.push({
          row, key, outcome: ran ? 'added' : 'linked',
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

  // Records go last and in batches: 13,000 photos are a few dozen requests.
  for (let i = 0; i < toRecord.length; i += RECORD_BATCH) {
    const chunk = toRecord.slice(i, i + RECORD_BATCH);
    let held: string | undefined;
    if (dry) {
      // Report what would happen; send and remember nothing.
    } else if (!recorder?.configured) {
      held = 'Worker not configured';
    } else {
      try {
        await recorder.recordMedia(chunk.map((c) => c.record));
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

  const counts: Record<Outcome, number> = { added: 0, linked: 0, unchanged: 0, held: 0, failed: 0 };
  for (const r of results) counts[r.outcome]++;
  return { files: results, uploadedBytes, counts };
}
