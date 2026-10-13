import { basename } from 'node:path';
import type { MediaKind, MediaRecord } from '@imagerepo/shared';
import { dateFromFilename } from '../exif.js';
import type { VideoProbe } from '../video.js';
import type { Stage } from './types.js';
import { exif, photoOriginal, derivatives, type ExifOut, type OriginalOut, type DerivativesOut } from './photo.js';
import { probe, videoOriginal, poster, preview, type PosterOut, type PreviewOut } from './video.js';

export type { Stage, StageInput, PipelineOptions } from './types.js';

/**
 * The pipeline, in order, for each kind of file. Add a stage here and every
 * file already ingested becomes its backlog.
 */
export const STAGES: Record<MediaKind, Stage<any>[]> = {
  photo: [exif, photoOriginal, derivatives],
  video: [probe, videoOriginal, poster, preview],
};

/**
 * Identifies what a database record was built from: the album it was filed
 * under and the version of every stage. If either changes, the record is
 * sent again — which is how a new album link or a re-run stage reaches D1.
 */
export const recordKey = (kind: MediaKind, album: string) =>
  `r1|${album}|${STAGES[kind].map((s) => `${s.name}@${s.version}`).join(',')}`;

export interface RecordSource {
  path: string; hash: string; kind: MediaKind; album: string; mtime: number;
}

/** Builds the row the Worker stores from what the stages produced. */
export function buildRecord(f: RecordSource, data: Record<string, unknown>): MediaRecord {
  const origName = basename(f.path);
  const stages = STAGES[f.kind].map((s) => ({ name: s.name, version: s.version }));
  const original = data.original as OriginalOut;

  if (f.kind === 'photo') {
    const { raw, ...e } = data.exif as ExifOut;
    const d = data.derivatives as DerivativesOut;
    return {
      id: f.hash, kind: 'photo', ext: original.ext, bytes: original.bytes,
      width: d.width, height: d.height,
      takenAt: e.takenAt ?? dateFromFilename(origName) ?? f.mtime,
      camera: e.camera, lens: e.lens, iso: e.iso, fstop: e.fstop, focalMm: e.focalMm,
      lat: e.lat, lon: e.lon,
      thumbhash: d.thumbhash,
      origName, sourcePath: f.path,
      albums: [f.album],
      derivatives: d.derivatives,
      rawMeta: raw, stages,
    };
  }

  const p = data.probe as VideoProbe & { raw?: Record<string, unknown> };
  const post = data.poster as PosterOut;
  // Rotated portrait video reports landscape dimensions in the stream header.
  const swap = p.rotation === 90 || p.rotation === 270;
  return {
    id: f.hash, kind: 'video', ext: 'mp4', bytes: original.bytes,
    width: swap ? p.height : p.width,
    height: swap ? p.width : p.height,
    durationMs: p.durationMs,
    takenAt: p.createdAt ?? dateFromFilename(origName) ?? f.mtime,
    lat: p.lat, lon: p.lon,
    thumbhash: post.thumbhash,
    origName, sourcePath: f.path,
    albums: [f.album],
    derivatives: [...post.derivatives, ...((data.preview as PreviewOut).made ? ['preview'] : [])],
    rawMeta: p.raw, stages,
  };
}
