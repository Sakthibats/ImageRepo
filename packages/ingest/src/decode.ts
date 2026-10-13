import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';

const run = promisify(execFile);

/**
 * Returns image bytes sharp can decode.
 *
 * sharp's prebuilt binaries read the HEIF container but ship no HEVC decoder,
 * so an iPhone HEIC fails with "No decoding plugin installed". Those are
 * converted first: with `sips` on macOS (Apple's own decoder, so tiled images,
 * rotation and wide colour all come out right), otherwise with ffmpeg.
 */
export async function decodableImage(path: string, ext: string, bytes: Buffer): Promise<Buffer> {
  if (ext !== 'heic' && ext !== 'heif') return bytes;

  try {
    await sharp(bytes, { failOn: 'none' }).resize(8).raw().toBuffer();
    return bytes;                           // this sharp build can decode it
  } catch { /* fall through to an external decoder */ }

  const errors: string[] = [];
  for (const [tool, ext2, args] of [
    ['sips', 'tiff', (out: string) => ['-s', 'format', 'tiff', path, '--out', out]],
    ['ffmpeg', 'png', (out: string) => ['-v', 'error', '-i', path, '-frames:v', '1', '-y', out]],
  ] as const) {
    if (tool === 'sips' && process.platform !== 'darwin') continue;
    const out = join(tmpdir(), `ir-heic-${randomUUID()}.${ext2}`);
    try {
      await run(tool, args(out), { maxBuffer: 1024 * 1024 * 16 });
      return await readFile(out);
    } catch (e: any) {
      errors.push(`${tool}: ${String(e?.stderr || e?.message || e).trim().split('\n')[0]}`);
    } finally {
      await unlink(out).catch(() => {});
    }
  }
  throw new Error(`could not decode HEIC (${errors.join('; ')})`);
}
