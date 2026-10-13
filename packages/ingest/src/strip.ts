import { stripJpegMetadata, type StripResult } from './jpeg.js';
import { stripPngMetadata } from './png.js';
import { stripHeicMetadata } from './heic.js';

/** Removes embedded metadata (and with it, location) without touching a pixel. */
export function stripMetadata(input: Buffer, ext: string): StripResult {
  switch (ext) {
    case 'jpg': case 'jpeg': return stripJpegMetadata(input);
    case 'png': return stripPngMetadata(input);
    case 'heic': case 'heif': return stripHeicMetadata(input);
    // Uploading a format we cannot clean would leak whatever it carries.
    default: throw new Error(`no metadata stripper for .${ext}`);
  }
}
