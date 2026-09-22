import { rgbaToThumbHash } from 'thumbhash';
import { adminApi, type UploadRecord } from './admin.ts';

/**
 * Client-side ingest. Mirrors what the CLI does, minus EXIF stripping: the
 * browser re-encodes every derivative through canvas, which discards metadata
 * by construction, and the original is uploaded as re-encoded JPEG rather than
 * the raw file — so no GPS reaches R2 from this path either.
 */

const WIDTHS = [320, 1024, 2048] as const;

/** AVIF encoding is not reliably available in canvas; WebP is universal. */
const DRV_EXT = 'webp';
const DRV_TYPE = 'image/webp';

export interface Progress {
  file: string; done: number; total: number; phase: string;
}

export async function uploadFiles(
  files: File[],
  albumId: string,
  onProgress: (p: Progress) => void,
): Promise<{ added: number; skipped: number; failed: string[] }> {
  const records: UploadRecord[] = [];
  const failed: string[] = [];
  let skipped = 0;
  let done = 0;

  for (const file of files) {
    onProgress({ file: file.name, done, total: files.length, phase: 'reading' });
    try {
      const buf = await file.arrayBuffer();
      const id = await sha256Hex(buf);

      const { known } = await adminApi.checkKnown([id]);
      if (known.includes(id)) { skipped++; done++; continue; }

      onProgress({ file: file.name, done, total: files.length, phase: 'processing' });
      const bitmap = await createImageBitmap(new Blob([buf], { type: file.type }));
      const width = bitmap.width;
      const height = bitmap.height;

      // Original, re-encoded. Canvas output carries no EXIF, so this strips
      // location without needing a JPEG parser in the browser.
      const originalBlob = await encode(bitmap, Math.min(width, 4096), 'image/jpeg', 0.92);
      await adminApi.putObject(id, 'orig', originalBlob, 'jpg');

      const derivatives: string[] = [];
      for (const w of WIDTHS) {
        if (w > width && w !== WIDTHS[0]) continue;
        onProgress({ file: file.name, done, total: files.length, phase: `${w}px` });
        const blob = await encode(bitmap, w, DRV_TYPE, 0.82);
        await adminApi.putObject(id, String(w), blob, DRV_EXT);
        derivatives.push(String(w));
      }

      const thumbhash = await makeThumbhash(bitmap);
      bitmap.close();

      records.push({
        id, width, height, bytes: originalBlob.size,
        takenAt: Math.floor(file.lastModified / 1000),
        thumbhash, origName: file.name, drvExt: DRV_EXT, derivatives,
      });
    } catch (e) {
      failed.push(`${file.name}: ${(e as Error).message}`);
    }
    done++;
    onProgress({ file: file.name, done, total: files.length, phase: 'done' });
  }

  if (records.length) {
    onProgress({ file: '', done, total: files.length, phase: 'saving' });
    await adminApi.commitUpload(albumId, records);
  }
  return { added: records.length, skipped, failed };
}

async function encode(
  bitmap: ImageBitmap, targetWidth: number, type: string, quality: number,
): Promise<Blob> {
  const scale = Math.min(1, targetWidth / bitmap.width);
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');
  ctx.drawImage(bitmap, 0, 0, w, h);
  return canvas.convertToBlob({ type, quality });
}

async function makeThumbhash(bitmap: ImageBitmap): Promise<string> {
  const scale = Math.min(100 / bitmap.width, 100 / bitmap.height, 1);
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  return btoa(String.fromCharCode(...rgbaToThumbHash(w, h, data)));
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
