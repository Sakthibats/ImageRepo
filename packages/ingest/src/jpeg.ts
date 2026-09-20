/**
 * Lossless JPEG metadata surgery.
 *
 * A JPEG is SOI (FFD8) followed by marker segments, then entropy-coded scan
 * data after SOS (FFDA). EXIF/GPS lives in APP1; XMP (which can ALSO carry
 * coordinates) lives in a second APP1; IPTC lives in APP13.
 *
 * Dropping those segments removes location without re-encoding anything, so
 * the image is bit-identical pixel-wise. We deliberately KEEP:
 *   APP0  (JFIF density)
 *   APP2  (ICC colour profile — dropping this visibly shifts colours)
 *   DQT/SOF/DHT/SOS and all scan data
 */

const SOI = 0xd8;
const SOS = 0xda;
const EOI = 0xd9;
const APP1 = 0xe1;   // EXIF + XMP
const APP13 = 0xed;  // IPTC / Photoshop

const STRIP = new Set([APP1, APP13]);

export interface StripResult {
  buffer: Buffer;
  removedBytes: number;
  strippedSegments: string[];
}

export function stripJpegMetadata(input: Buffer): StripResult {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== SOI) {
    // Not a JPEG we recognise — hand it back untouched rather than corrupt it.
    return { buffer: input, removedBytes: 0, strippedSegments: [] };
  }

  const keep: Buffer[] = [input.subarray(0, 2)]; // SOI
  const stripped: string[] = [];
  let removed = 0;
  let p = 2;

  while (p < input.length - 1) {
    if (input[p] !== 0xff) break;                 // desync; bail out safely

    const marker = input[p + 1];

    if (marker === 0xff) { p++; continue; }       // fill byte
    if (marker === EOI) { keep.push(input.subarray(p)); p = input.length; break; }

    if (marker === SOS) {
      // Everything from here to EOI is scan data — copy verbatim and stop.
      keep.push(input.subarray(p));
      p = input.length;
      break;
    }

    if (p + 4 > input.length) break;
    const len = input.readUInt16BE(p + 2);        // includes the 2 length bytes
    if (len < 2 || p + 2 + len > input.length) break;

    const segment = input.subarray(p, p + 2 + len);
    if (STRIP.has(marker)) {
      removed += segment.length;
      stripped.push(`APP${marker - 0xe0}`);
    } else {
      keep.push(segment);
    }
    p += 2 + len;
  }

  // If we bailed mid-file, keep the remainder so we never truncate an image.
  if (p < input.length) keep.push(input.subarray(p));

  return {
    buffer: Buffer.concat(keep),
    removedBytes: removed,
    strippedSegments: [...new Set(stripped)],
  };
}
