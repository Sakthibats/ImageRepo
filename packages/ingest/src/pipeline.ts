import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { MediaRecord } from '@imagerepo/shared';
import { r2Key } from '@imagerepo/shared';
import { hashFile } from './hash.js';
import { readExif, dateFromFilename } from './exif.js';
import { stripJpegMetadata } from './jpeg.js';
import { processPhoto, makeThumbHash } from './photo.js';
import { probeVideo, remuxFaststart, transcodePreview, extractPoster, isWebPlayable } from './video.js';
import type { R2 } from './r2.js';
import { contentTypeFor } from './r2.js';
import type { FileRow } from './state.js';

export interface PipelineOptions {
  /** Upload byte-exact originals instead of stripping GPS from them. */
  preserveOriginal?: boolean;
  /** Generate a 720p H.264 preview for every video, not just unplayable ones. */
  previewAllVideo?: boolean;
  /** Process locally but upload nothing. */
  dryRun?: boolean;
}

export interface PipelineResult {
  record: MediaRecord;
  uploadedBytes: number;
  skipped: boolean;
}

export async function processFile(
  row: FileRow,
  r2: R2 | null,
  opts: PipelineOptions,
): Promise<PipelineResult> {
  const hash = row.hash ?? (await hashFile(row.path));
  const ext = extname(row.path).toLowerCase().replace(/^\./, '');
  const origName = basename(row.path);
  let uploaded = 0;

  const put = async (key: string, body: Buffer, ct: string) => {
    if (opts.dryRun || !r2) { uploaded += body.length; return; }
    if (await r2.exists(key)) return;          // content-addressed: already there
    await r2.put(key, body, ct);
    uploaded += body.length;
  };

  if (row.kind === 'photo') {
    return processPhotoFile({ row, hash, ext, origName, put, opts, uploaded: () => uploaded });
  }
  return processVideoFile({ row, hash, ext, origName, put, opts, uploaded: () => uploaded });
}

type Ctx = {
  row: FileRow; hash: string; ext: string; origName: string;
  put: (key: string, body: Buffer, ct: string) => Promise<void>;
  opts: PipelineOptions;
  uploaded: () => number;
};

async function processPhotoFile(c: Ctx): Promise<PipelineResult> {
  const input = await readFile(c.row.path);

  // 1. Capture metadata BEFORE stripping — this is what reaches D1.
  const exif = await readExif(c.row.path);

  // 2. Derivatives. sharp emits no metadata, so these are GPS-free by construction.
  const { width, height, thumbhash, derivatives } = await processPhoto(input);

  // 3. The original. Default: lose the GPS, keep every pixel.
  let original: Buffer = input;
  if (!c.opts.preserveOriginal && (c.ext === 'jpg' || c.ext === 'jpeg')) {
    original = stripJpegMetadata(input).buffer;
  }

  await c.put(r2Key.original(c.hash, c.ext), original, contentTypeFor(c.ext));
  for (const d of derivatives) {
    await c.put(r2Key.derivative(c.hash, d.width), d.body, 'image/avif');
  }

  return {
    record: {
      id: c.hash,
      kind: 'photo',
      ext: c.ext,
      bytes: original.length,
      width, height,
      takenAt: exif.takenAt ?? dateFromFilename(c.origName) ?? c.row.mtime,
      camera: exif.camera, lens: exif.lens, iso: exif.iso,
      fstop: exif.fstop, focalMm: exif.focalMm,
      lat: exif.lat, lon: exif.lon,
      thumbhash,
      origName: c.origName,
      sourcePath: c.row.path,
      albums: [c.row.album],
      derivatives: derivatives.map((d) => d.name),
    },
    uploadedBytes: c.uploaded(),
    skipped: false,
  };
}

async function processVideoFile(c: Ctx): Promise<PipelineResult> {
  const probe = await probeVideo(c.row.path);
  const derivatives: string[] = [];

  // Remux is lossless and drops container GPS. Skip only if already clean+faststart.
  const needsRemux = !c.opts.preserveOriginal &&
    (!probe.hasFaststart || probe.lat !== undefined || probe.lon !== undefined);

  const original = needsRemux
    ? await remuxFaststart(c.row.path)
    : await readFile(c.row.path);

  await c.put(r2Key.original(c.hash, 'mp4'), original, 'video/mp4');

  // Poster frame, then run it through the photo pipeline so the grid gets
  // the same thumbnail sizes as a still.
  const poster = await extractPoster(c.row.path, probe.durationMs);
  await c.put(r2Key.poster(c.hash), poster, 'image/jpeg');
  derivatives.push('poster');

  const posterDerivs = await processPhoto(poster);
  for (const d of posterDerivs.derivatives) {
    await c.put(r2Key.derivative(c.hash, d.width), d.body, 'image/avif');
    derivatives.push(d.name);
  }

  // A browser-playable copy when the source codec won't play everywhere,
  // or always if asked (saves mobile data for guests).
  if (c.opts.previewAllVideo || !isWebPlayable(probe.codec)) {
    const preview = await transcodePreview(c.row.path);
    await c.put(r2Key.videoPreview(c.hash), preview, 'video/mp4');
    derivatives.push('preview');
  }

  // Rotated portrait video reports landscape dimensions in the stream header.
  const swap = probe.rotation === 90 || probe.rotation === 270;

  return {
    record: {
      id: c.hash,
      kind: 'video',
      ext: 'mp4',
      bytes: original.length,
      width: swap ? probe.height : probe.width,
      height: swap ? probe.width : probe.height,
      durationMs: probe.durationMs,
      takenAt: probe.createdAt ?? dateFromFilename(c.origName) ?? c.row.mtime,
      lat: probe.lat, lon: probe.lon,
      thumbhash: posterDerivs.thumbhash,
      origName: c.origName,
      sourcePath: c.row.path,
      albums: [c.row.album],
      derivatives,
    },
    uploadedBytes: c.uploaded(),
    skipped: false,
  };
}
