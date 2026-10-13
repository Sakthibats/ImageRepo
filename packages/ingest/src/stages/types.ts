import type { MediaKind } from '@imagerepo/shared';

export interface PipelineOptions {
  /** Upload byte-exact originals instead of stripping GPS from them. */
  preserveOriginal?: boolean;
  /** Generate a 720p H.264 preview for every video, not just unplayable ones. */
  previewAllVideo?: boolean;
  /** Process locally but upload nothing and remember nothing. */
  dryRun?: boolean;
}

/** What a stage is handed for one file. */
export interface StageInput {
  path: string;
  hash: string;
  kind: MediaKind;
  ext: string;                 // lower-case, no dot
  opts: PipelineOptions;
  /** The file's bytes, read once and shared between stages. */
  bytes(): Promise<Buffer>;
  /** The output of an earlier stage, as named in `needs`. */
  data<T>(stage: string): T;
  /** Stores an object in R2 (a no-op on a dry run, or if it is already there). */
  put(key: string, body: Buffer, contentType: string): Promise<void>;
}

/**
 * One step of processing.
 *
 * A stage's output depends only on the file's bytes, so results are stored
 * against the content hash: the same photo in two folders is processed once.
 * `run` must be safe to repeat — it is re-run after any interruption — and its
 * return value must be small, JSON-safe data, which later stages and the final
 * database record are built from.
 *
 * To add processing later: write a stage, add it to the list in ./index.ts.
 * Every file already ingested then lacks it, which is exactly the backlog.
 * To redo a stage for everything, bump its `version`.
 */
export interface Stage<T = unknown> {
  name: string;
  version: number;
  needs?: string[];
  run(input: StageInput): Promise<T>;
}
