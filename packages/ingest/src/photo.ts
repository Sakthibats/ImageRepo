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

/**
 * AVIF encoder effort, 0 (fastest) to 9. Measured on 26MP wedding JPEGs on an
 * M2: effort 4 took ~5s of CPU per photo and was 90% of total ingest time;
 * effort 2 takes ~0.9s for files about 3% larger. Past that, uploading the
 * original is the bottleneck, so more speed here buys nothing.
 */
const EFFORT = 2;

export async function processPhoto(input: Buffer): Promise<PhotoResult> {
  const meta = await sharp(input, { failOn: 'none' }).metadata();
  // metadata() describes the stored pixels. EXIF orientations 5-8 mean the
  // camera was turned, so the picture as seen is the other way round.
  const turned = (meta.orientation ?? 1) >= 5;
  const width = (turned ? meta.height : meta.width) ?? 0;
  const height = (turned ? meta.width : meta.height) ?? 0;
  if (!width || !height) throw new Error('could not read image dimensions');

  // Decode the full image once, upright, at the largest size we keep; every
  // smaller size is made from that. .rotate() applies EXIF orientation, and
  // nothing downstream sees metadata, so every derivative is GPS-free by
  // construction.
  const largest = PHOTO_WIDTHS[PHOTO_WIDTHS.length - 1];
  const base = await sharp(input, { failOn: 'none' })
    .rotate()
    .resize({ width: largest, withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const raw = { raw: { width: base.info.width, height: base.info.height, channels: base.info.channels } };

  const derivatives: Derivative[] = [];
  for (const w of PHOTO_WIDTHS) {
    // Never upscale: a 900px-wide source should not produce a 2048 variant.
    if (w > width && w !== PHOTO_WIDTHS[0]) continue;
    const body = await sharp(base.data, raw)
      .resize({ width: w, withoutEnlargement: true })
      .avif({ quality: QUALITY[w] ?? 58, effort: EFFORT })
      .toBuffer();
    derivatives.push({ name: String(w), width: w, body });
  }

  const thumbhash = await hashOf(sharp(base.data, raw));
  return { width, height, thumbhash, derivatives };
}

/** ThumbHash needs a tiny RGBA bitmap, max 100x100. ~28 bytes out. */
async function hashOf(img: sharp.Sharp): Promise<string> {
  const { data, info } = await img
    .resize(100, 100, { fit: 'inside' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return Buffer.from(rgbaToThumbHash(info.width, info.height, data)).toString('base64');
}

export async function makeThumbHash(input: Buffer): Promise<string> {
  return hashOf(sharp(input, { failOn: 'none' }).rotate());
}
