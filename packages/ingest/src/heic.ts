import type { StripResult } from './jpeg.js';

/**
 * Lossless HEIC/HEIF metadata removal.
 *
 * A HEIC file is a tree of boxes. The image and its metadata are separate
 * "items": `iinf` names each item's type, `iloc` says which bytes it occupies.
 * EXIF is an item of type "Exif"; XMP is a "mime" item.
 *
 * Removing an item would mean rewriting every offset in the file. Instead the
 * metadata bytes are overwritten in place: EXIF with a valid, empty EXIF
 * block, XMP with spaces. The file keeps its exact size and layout and the
 * coded image is not touched, so pixels are bit-identical. Rotation is safe:
 * HEIC carries it in an `irot` property, not in EXIF.
 *
 * Anything this cannot parse is an error rather than a pass-through — an
 * unstripped file must never be uploaded as if it were clean.
 */

interface Box { type: string; start: number; body: number; end: number }

function* boxes(buf: Buffer, start: number, end: number): Generator<Box> {
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    let header = 8;
    if (size === 1) {
      if (p + 16 > end) throw new Error('truncated box');
      size = Number(buf.readBigUInt64BE(p + 8));
      header = 16;
    } else if (size === 0) {
      size = end - p;                       // "extends to end of file"
    }
    if (size < header || p + size > end) throw new Error(`malformed ${type} box`);
    yield { type, start: p, body: p + header, end: p + size };
    p += size;
  }
}

const find = (buf: Buffer, start: number, end: number, type: string) => {
  for (const b of boxes(buf, start, end)) if (b.type === type) return b;
  return undefined;
};

/** Reads an unsigned big-endian integer of 0, 2, 4 or 8 bytes. */
function uint(buf: Buffer, p: number, size: number): number {
  if (size === 0) return 0;
  if (size === 2) return buf.readUInt16BE(p);
  if (size === 4) return buf.readUInt32BE(p);
  if (size === 8) return Number(buf.readBigUInt64BE(p));
  throw new Error(`unsupported field size ${size}`);
}

const cstring = (buf: Buffer, p: number, end: number) => {
  let q = p;
  while (q < end && buf[q] !== 0) q++;
  return { text: buf.toString('latin1', p, q), next: q + 1 };
};

/** item id -> what kind of metadata it is, for the items we want gone. */
function metadataItems(buf: Buffer, iinf: Box): Map<number, 'Exif' | 'XMP'> {
  const out = new Map<number, 'Exif' | 'XMP'>();
  const version = buf[iinf.body];
  const first = iinf.body + 4 + (version === 0 ? 2 : 4);

  for (const infe of boxes(buf, first, iinf.end)) {
    if (infe.type !== 'infe') continue;
    const v = buf[infe.body];
    if (v < 2) continue;                    // v0/v1 predate item types; HEIC uses v2+
    let p = infe.body + 4;
    const id = v === 2 ? buf.readUInt16BE(p) : buf.readUInt32BE(p);
    p += (v === 2 ? 2 : 4) + 2;             // id, protection index
    const type = buf.toString('latin1', p, p + 4);
    p += 4;

    if (type === 'Exif') { out.set(id, 'Exif'); continue; }
    if (type === 'mime') {
      const name = cstring(buf, p, infe.end);
      const contentType = cstring(buf, name.next, infe.end).text.toLowerCase();
      if (contentType.includes('xml') || contentType.includes('xmp')) out.set(id, 'XMP');
    }
  }
  return out;
}

/** Absolute byte ranges of each wanted item, read from `iloc`. */
function itemExtents(
  buf: Buffer, iloc: Box, idat: Box | undefined, wanted: Map<number, unknown>,
): Map<number, [number, number][]> {
  const version = buf[iloc.body];
  if (version > 2) throw new Error(`unsupported iloc version ${version}`);
  let p = iloc.body + 4;
  const offsetSize = buf[p] >> 4;
  const lengthSize = buf[p] & 0x0f;
  const baseOffsetSize = buf[p + 1] >> 4;
  const indexSize = version > 0 ? buf[p + 1] & 0x0f : 0;
  p += 2;
  const count = version < 2 ? buf.readUInt16BE(p) : buf.readUInt32BE(p);
  p += version < 2 ? 2 : 4;

  const out = new Map<number, [number, number][]>();
  for (let i = 0; i < count; i++) {
    const id = version < 2 ? buf.readUInt16BE(p) : buf.readUInt32BE(p);
    p += version < 2 ? 2 : 4;
    let method = 0;
    if (version > 0) { method = buf.readUInt16BE(p) & 0x0f; p += 2; }
    p += 2;                                 // data reference index
    const base = uint(buf, p, baseOffsetSize);
    p += baseOffsetSize;
    const extentCount = buf.readUInt16BE(p);
    p += 2;

    const ranges: [number, number][] = [];
    for (let e = 0; e < extentCount; e++) {
      p += indexSize;
      const offset = uint(buf, p, offsetSize); p += offsetSize;
      const length = uint(buf, p, lengthSize); p += lengthSize;
      ranges.push([base + offset, length]);
    }
    if (!wanted.has(id)) continue;

    // Method 0 is an offset into the file; method 1 into the `idat` box.
    // Method 2 (another item's data) is never used for metadata.
    const origin = method === 0 ? 0 : method === 1 && idat ? idat.body : -1;
    if (origin < 0) throw new Error(`unsupported item construction method ${method}`);
    out.set(id, ranges.map(([o, l]) => [origin + o, l]));
  }
  return out;
}

/** A well-formed EXIF block with no tags: offset, "Exif\0\0", TIFF header, empty IFD. */
const EMPTY_EXIF = Buffer.from([
  0, 0, 0, 6, 0x45, 0x78, 0x69, 0x66, 0, 0,
  0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8,
  0, 0, 0, 0, 0, 0,
]);

export function stripHeicMetadata(input: Buffer): StripResult {
  if (input.length < 12 || input.toString('latin1', 4, 8) !== 'ftyp') {
    throw new Error('not a HEIC/HEIF file');
  }
  const meta = find(input, 0, input.length, 'meta');
  if (!meta) throw new Error('HEIC has no meta box');
  const children = [meta.body + 4, meta.end] as const;   // meta is a FullBox
  const iinf = find(input, ...children, 'iinf');
  const iloc = find(input, ...children, 'iloc');
  if (!iinf || !iloc) throw new Error('HEIC has no item table');

  const wanted = metadataItems(input, iinf);
  if (!wanted.size) return { buffer: input, removedBytes: 0, strippedSegments: [] };

  const extents = itemExtents(input, iloc, find(input, ...children, 'idat'), wanted);
  const out = Buffer.from(input);
  let removed = 0;

  for (const [id, kind] of wanted) {
    const ranges = extents.get(id);
    if (!ranges) throw new Error(`HEIC ${kind} item has no location`);
    ranges.forEach(([start, length], i) => {
      if (start + length > out.length) throw new Error(`HEIC ${kind} item runs past end of file`);
      out.fill(kind === 'XMP' ? 0x20 : 0, start, start + length);
      if (kind === 'Exif' && i === 0 && length >= EMPTY_EXIF.length) EMPTY_EXIF.copy(out, start);
      removed += length;
    });
  }

  return { buffer: out, removedBytes: removed, strippedSegments: [...new Set(wanted.values())] };
}
