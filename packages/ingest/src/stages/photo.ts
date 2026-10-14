import { r2Key } from '@imagerepo/shared';
import { readExif, readRawMeta, type ExifData } from '../exif.js';
import { stripMetadata } from '../strip.js';
import { decodableImage } from '../decode.js';
import { processPhoto } from '../photo.js';
import { contentTypeFor } from '../r2.js';
import type { Stage } from './types.js';

export interface ExifOut extends ExifData { raw?: Record<string, unknown> }
export interface OriginalOut { ext: string; bytes: number; stripped: string[] }
export interface DerivativesOut { width: number; height: number; thumbhash: string; derivatives: string[] }

/** Captures metadata BEFORE anything is stripped — this is what reaches D1. */
export const exif: Stage<ExifOut> = {
  name: 'exif',
  // v2: also keeps every tag the camera wrote (`raw`), not just the modelled ones.
  version: 2,
  async run({ path }) {
    return { ...(await readExif(path)), raw: await readRawMeta(path) };
  },
};

/** The original. Default: lose the metadata, keep every pixel. */
export const photoOriginal: Stage<OriginalOut> = {
  name: 'original',
  version: 1,
  async run({ hash, ext, opts, bytes, put }) {
    const input = await bytes();
    const { buffer, strippedSegments } = opts.preserveOriginal
      ? { buffer: input, strippedSegments: [] }
      : stripMetadata(input, ext);
    await put(r2Key.original(hash, ext), buffer, contentTypeFor(ext));
    return { ext, bytes: buffer.length, stripped: strippedSegments };
  },
};

/** Resized copies. sharp emits no metadata, so these are GPS-free by construction. */
export const derivatives: Stage<DerivativesOut> = {
  name: 'derivatives',
  // v2: correct width/height for photos the camera marked as rotated.
  version: 2,
  async run({ path, hash, ext, bytes, put }) {
    const image = await decodableImage(path, ext, await bytes());
    const { width, height, thumbhash, derivatives } = await processPhoto(image);
    for (const d of derivatives) {
      await put(r2Key.derivative(hash, d.width), d.body, 'image/avif');
    }
    return { width, height, thumbhash, derivatives: derivatives.map((d) => d.name) };
  },
};
