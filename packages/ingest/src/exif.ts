import exifr from 'exifr';

export interface ExifData {
  takenAt?: number;      // epoch seconds
  camera?: string;
  lens?: string;
  iso?: number;
  fstop?: number;
  focalMm?: number;
  lat?: number;
  lon?: number;
  orientation?: number;
}

/**
 * Reads EXIF from the file header only — exifr stops once it has the blocks it
 * needs, so this never pulls a whole 8MB JPEG into memory.
 *
 * GPS is extracted here and stored in D1. It is deliberately NOT left in the
 * copy we upload (see jpeg.ts / stripJpegMetadata).
 */
export async function readExif(path: string): Promise<ExifData> {
  let raw: any;
  try {
    raw = await exifr.parse(path, {
      tiff: true, exif: true, gps: true,
      pick: [
        'DateTimeOriginal', 'CreateDate', 'ModifyDate',
        'Make', 'Model', 'LensModel',
        'ISO', 'FNumber', 'FocalLength', 'Orientation',
        'latitude', 'longitude',
      ],
    });
  } catch {
    return {};                       // unreadable EXIF is not fatal
  }
  if (!raw) return {};

  const when: Date | undefined =
    raw.DateTimeOriginal ?? raw.CreateDate ?? raw.ModifyDate;

  const make = typeof raw.Make === 'string' ? raw.Make.trim() : '';
  const model = typeof raw.Model === 'string' ? raw.Model.trim() : '';
  // Model is self-identifying on essentially every camera and phone
  // ("iPhone 14 Pro", "Pixel 8", "Canon EOS R5"), so prefer it alone and fall
  // back to Make only when Model is missing.
  const camera = model || make;

  return {
    takenAt: when instanceof Date && !isNaN(+when) ? Math.floor(+when / 1000) : undefined,
    camera: camera || undefined,
    lens: raw.LensModel || undefined,
    iso: typeof raw.ISO === 'number' ? raw.ISO : undefined,
    fstop: typeof raw.FNumber === 'number' ? raw.FNumber : undefined,
    focalMm: typeof raw.FocalLength === 'number' ? raw.FocalLength : undefined,
    lat: typeof raw.latitude === 'number' ? raw.latitude : undefined,
    lon: typeof raw.longitude === 'number' ? raw.longitude : undefined,
    orientation: typeof raw.Orientation === 'number' ? raw.Orientation : undefined,
  };
}

/** Fallback when EXIF has no date: parse common phone filename patterns. */
export function dateFromFilename(name: string): number | undefined {
  // IMG_20231215_143022.jpg / 20231215_143022.jpg / PXL_20231215_143022123.jpg
  const m = name.match(/(20\d{2})(\d{2})(\d{2})[_-]?(\d{2})?(\d{2})?(\d{2})?/);
  if (!m) return undefined;
  const [, y, mo, d, h = '12', mi = '00', s = '00'] = m;
  const t = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
  return isNaN(t) ? undefined : Math.floor(t / 1000);
}

const MAX_RAW_META = 24 * 1024;

/** Makes a parsed tag value JSON-safe, dropping binary blobs. */
function plain(v: unknown): unknown {
  if (v instanceof Date) return isNaN(+v) ? undefined : v.toISOString();
  if (v instanceof Uint8Array || v instanceof ArrayBuffer) return undefined;
  if (Array.isArray(v)) return v.length <= 16 ? v.map(plain).filter((x) => x !== undefined) : undefined;
  if (typeof v === 'string') return v.length <= 500 ? v : undefined;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'boolean') return v;
  return undefined;                    // nested objects, maker notes, etc.
}

/**
 * Every tag the camera wrote, as plain JSON. The uploaded original is
 * stripped, so this is the only copy: a later stage that wants a field we do
 * not model today (lens serial, subject distance, altitude) reads it from here.
 */
export async function readRawMeta(path: string): Promise<Record<string, unknown> | undefined> {
  let raw: Record<string, unknown> | undefined;
  try {
    raw = await exifr.parse(path, {
      tiff: true, exif: true, gps: true,
      xmp: false, icc: false, iptc: false, makerNote: false, userComment: false,
    });
  } catch {
    return undefined;
  }
  if (!raw) return undefined;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    const value = plain(v);
    if (value !== undefined) out[k] = value;
  }
  if (!Object.keys(out).length) return undefined;
  return JSON.stringify(out).length <= MAX_RAW_META ? out : undefined;
}
