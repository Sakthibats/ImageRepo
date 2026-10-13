import { readFile } from 'node:fs/promises';
import { r2Key } from '@imagerepo/shared';
import {
  probeVideo, remuxFaststart, transcodePreview, extractPoster, isWebPlayable,
  type VideoProbe,
} from '../video.js';
import { processPhoto } from '../photo.js';
import type { Stage } from './types.js';
import type { OriginalOut } from './photo.js';

export interface PosterOut { thumbhash: string; derivatives: string[] }
export interface PreviewOut { made: boolean }

/** Stream and container metadata, read without decoding a frame. */
export const probe: Stage<VideoProbe> = {
  name: 'probe',
  version: 1,
  run: ({ path }) => probeVideo(path),
};

export const videoOriginal: Stage<OriginalOut> = {
  name: 'original',
  version: 1,
  needs: ['probe'],
  async run({ path, hash, opts, data, put }) {
    const p = data<VideoProbe>('probe');
    // Remux is lossless and drops container GPS. Skip only if already clean+faststart.
    const needsRemux = !opts.preserveOriginal &&
      (!p.hasFaststart || p.lat !== undefined || p.lon !== undefined);
    const original = needsRemux ? await remuxFaststart(path) : await readFile(path);
    await put(r2Key.original(hash, 'mp4'), original, 'video/mp4');
    return { ext: 'mp4', bytes: original.length, stripped: needsRemux ? ['container'] : [] };
  },
};

/** A poster frame, run through the photo resizer so the grid gets the same sizes as a still. */
export const poster: Stage<PosterOut> = {
  name: 'poster',
  version: 1,
  needs: ['probe'],
  async run({ path, hash, data, put }) {
    const frame = await extractPoster(path, data<VideoProbe>('probe').durationMs);
    await put(r2Key.poster(hash), frame, 'image/jpeg');
    const { thumbhash, derivatives } = await processPhoto(frame);
    for (const d of derivatives) {
      await put(r2Key.derivative(hash, d.width), d.body, 'image/avif');
    }
    return { thumbhash, derivatives: ['poster', ...derivatives.map((d) => d.name)] };
  },
};

/**
 * A browser-playable copy when the source codec won't play everywhere, or
 * always if asked (saves mobile data for guests).
 */
export const preview: Stage<PreviewOut> = {
  name: 'preview',
  version: 1,
  needs: ['probe'],
  async run({ path, hash, opts, data, put }) {
    if (!opts.previewAllVideo && isWebPlayable(data<VideoProbe>('probe').codec)) {
      return { made: false };
    }
    await put(r2Key.videoPreview(hash), await transcodePreview(path), 'video/mp4');
    return { made: true };
  },
};
