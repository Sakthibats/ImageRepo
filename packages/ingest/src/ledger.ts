import type { MediaRecord } from '@imagerepo/shared';
import { IngestState, type FileRow, type StageRun } from './state.js';
import { STAGES, recordKey } from './stages/index.js';

export type FileState = 'recorded' | 'uploaded' | 'pending' | 'failed';

/** The stage results a file needs, if every one is done at the current version. */
export function completeData(
  kind: FileRow['kind'], runs: Map<string, StageRun> | undefined,
): Record<string, unknown> | null {
  const data: Record<string, unknown> = {};
  for (const stage of STAGES[kind]) {
    const run = runs?.get(stage.name);
    if (!run || run.state !== 'done' || run.version !== stage.version) return null;
    data[stage.name] = run.data;
  }
  return data;
}

/**
 * Where a file stands. Nothing stores this: it is worked out from which
 * stages are done, so there is no status flag to fall out of step with
 * reality — the bug that let a dry run mark files as finished.
 */
export function fileState(f: FileRow, runs: Map<string, StageRun> | undefined): FileState {
  if (f.error) return 'failed';
  const failed = STAGES[f.kind].some((s) => {
    const run = runs?.get(s.name);
    return run?.state === 'failed' && run.version === s.version;
  });
  if (failed) return 'failed';
  if (!f.hash || !completeData(f.kind, runs)) return 'pending';
  return f.recordedKey === recordKey(f.kind, f.album) ? 'recorded' : 'uploaded';
}

/** The first failure for a file, as "stage: reason". */
export function failureOf(f: FileRow, runs: Map<string, StageRun> | undefined): string | null {
  if (f.error) return f.error;
  for (const s of STAGES[f.kind]) {
    const run = runs?.get(s.name);
    if (run?.state === 'failed') return `${s.name}: ${run.error ?? 'failed'} (${run.attempts} attempts)`;
  }
  return null;
}

/**
 * Converts a ledger from before stages existed.
 *
 *  - Files that were really uploaded keep that standing: their stage results
 *    are rebuilt from the record saved at the time, so nothing is redone.
 *  - Files a dry run marked "processed" were never uploaded. The old CLI
 *    treated them as finished; they go back to pending.
 */
function convertLegacy(state: IngestState) {
  state.transaction(() => {
    for (const row of state.legacyRows()) {
      const real = row.status === 'uploaded' || row.status === 'recorded';
      if (!real || !row.hash || !row.record) {
        if (row.status !== 'failed') state.setStatus(row.path, 'pending');
        continue;
      }
      const r = JSON.parse(row.record) as MediaRecord;
      const done = (stage: string, data: unknown) => state.saveRun(row.hash!, stage, 1, data);

      if (row.kind === 'photo') {
        done('exif', {
          takenAt: r.takenAt, camera: r.camera, lens: r.lens, iso: r.iso,
          fstop: r.fstop, focalMm: r.focalMm, lat: r.lat, lon: r.lon,
        });
        done('original', { ext: r.ext, bytes: r.bytes, stripped: [] });
        done('derivatives', {
          width: r.width, height: r.height, thumbhash: r.thumbhash, derivatives: r.derivatives,
        });
      } else {
        // The saved width/height are already display-oriented.
        done('probe', {
          width: r.width, height: r.height, durationMs: r.durationMs, rotation: 0,
          codec: 'h264', hasFaststart: true, createdAt: r.takenAt, lat: r.lat, lon: r.lon,
        });
        done('original', { ext: 'mp4', bytes: r.bytes, stripped: [] });
        done('poster', {
          thumbhash: r.thumbhash, derivatives: r.derivatives.filter((d) => d !== 'preview'),
        });
        done('preview', { made: r.derivatives.includes('preview') });
      }
      if (row.status === 'recorded') state.setRecorded(row.path, recordKey(row.kind, row.album));
    }
    state.schemaVersion = 2;
  });
}

export function openLedger(path: string): IngestState {
  const state = new IngestState(path);
  if (state.schemaVersion < 2) convertLegacy(state);
  return state;
}
