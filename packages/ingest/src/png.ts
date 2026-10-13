import type { StripResult } from './jpeg.js';

/**
 * Lossless PNG metadata removal.
 *
 * A PNG is an 8-byte signature followed by chunks: length, type, data, CRC.
 * Location can sit in eXIf (raw EXIF) or in a text chunk (XMP is stored as
 * iTXt "XML:com.adobe.xmp"). Dropping whole chunks leaves the image data and
 * every remaining CRC untouched. Colour chunks (iCCP, sRGB, gAMA, cHRM) are
 * kept — losing them visibly shifts colours.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const STRIP = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt']);

export function stripPngMetadata(input: Buffer): StripResult {
  if (input.length < 8 || !input.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('not a PNG file');
  }

  const keep: Buffer[] = [input.subarray(0, 8)];
  const stripped: string[] = [];
  let removed = 0;
  let p = 8;

  while (p + 12 <= input.length) {
    const len = input.readUInt32BE(p);
    const type = input.toString('latin1', p + 4, p + 8);
    const end = p + 12 + len;
    if (end > input.length) throw new Error('truncated PNG chunk');

    if (STRIP.has(type)) {
      removed += end - p;
      stripped.push(type);
    } else {
      keep.push(input.subarray(p, end));
    }
    p = end;
    if (type === 'IEND') break;
  }

  return { buffer: Buffer.concat(keep), removedBytes: removed, strippedSegments: [...new Set(stripped)] };
}
