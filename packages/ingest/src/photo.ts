import sharp from 'sharp';
import { rgbaToThumbHash } from 'thumbhash';
import { PHOTO_WIDTHS } from '@imagerepo/shared';

export interface Derivative {
  name: string;          // '320' | '1024' | '2048'
  width: number;
  body: Buffer;
}

export interface PhotoResult {
  width: number;         // post-rotation display dimensions
  height: number;
  thumbhash: string;     // base64
  derivatives: Derivative[];
}

/** AVIF quality per width. Small images can afford lower quality; the lightbox
 *  image is what people actually scrutinise, so it gets the most bits. */
const QUALITY: Record<number, number> = { 320: 55, 1024: 58, 2048: 62 };

export async function processPhoto(input: Buffer): Promise<PhotoResult> {
  // .rotate() with no argument applies the EXIF orientation and then drops it,
  // so downstream sizes are true display dimensions and nothing depends on a
  // metadata tag we are about to strip.
  const base = sharp(input, { failOn: 'none' }).rotate();
  const meta = await base.metadata();

  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) throw new Error('could not read image dimensions');

  const derivatives: Derivative[] = [];
  for (const w of PHOTO_WIDTHS) {
    // Never upscale: a 900px-wide source should not produce a 2048 variant.
    if (w > width && w !== PHOTO_WIDTHS[0]) continue;
    const body = await sharp(input, { failOn: 'none' })
      .rotate()
      .resize({ width: w, withoutEnlargement: true })
      // sharp drops metadata unless withMetadata() is called, so every
      // derivative is EXIF-free (and therefore GPS-free) by construction.
      .avif({ quality: QUALITY[w] ?? 58, effort: 4 })
      .toBuffer();
    derivatives.push({ name: String(w), width: w, body });
  }

  return { width, height, thumbhash: await makeThumbHash(input), derivatives };
}

/** ThumbHash needs a tiny RGBA bitmap, max 100x100. ~28 bytes out. */
export async function makeThumbHash(input: Buffer): Promise<string> {
  const { data, info } = await sharp(input, { failOn: 'none' })
    .rotate()
    .resize(100, 100, { fit: 'inside' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const hash = rgbaToThumbHash(info.width, info.height, data);
  return Buffer.from(hash).toString('base64');
}
