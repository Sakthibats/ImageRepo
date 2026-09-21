import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { VIDEO_PREVIEW_HEIGHT } from '@imagerepo/shared';

const run = promisify(execFile);
const MAX_BUFFER = 1024 * 1024 * 64;

export interface VideoProbe {
  width: number;
  height: number;
  durationMs: number;
  codec: string;
  hasFaststart: boolean;
  createdAt?: number;
  lat?: number;
  lon?: number;
  rotation: number;
}

/** Reads stream + container metadata without decoding a single frame. */
export async function probeVideo(path: string): Promise<VideoProbe> {
  const { stdout } = await run('ffprobe', [
    '-v', 'quiet', '-print_format', 'json',
    '-show_streams', '-show_format', path,
  ], { maxBuffer: MAX_BUFFER });

  const data = JSON.parse(stdout);
  const v = (data.streams ?? []).find((s: any) => s.codec_type === 'video');
  if (!v) throw new Error('no video stream');

  const tags = { ...(data.format?.tags ?? {}), ...(v.tags ?? {}) };

  // Apple writes location as "+15.4909+073.8278/" in com.apple.quicktime.location.ISO6709
  const iso6709 = tags['com.apple.quicktime.location.ISO6709'] ?? tags['location'] ?? '';
  const geo = /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/.exec(iso6709);

  // Rotation can live in a display matrix side-data entry rather than a tag.
  const matrixRot = (v.side_data_list ?? [])
    .find((s: any) => s.rotation !== undefined)?.rotation;

  const created = tags['creation_time'] ? Date.parse(tags['creation_time']) : NaN;

  return {
    width: Number(v.width) || 0,
    height: Number(v.height) || 0,
    durationMs: Math.round(Number(data.format?.duration ?? v.duration ?? 0) * 1000),
    codec: String(v.codec_name ?? '').toLowerCase(),
    // start_time ~0 plus a moov-first layout is what lets a browser start
    // playing before the whole file arrives.
    hasFaststart: await probeFaststart(path),
    createdAt: isNaN(created) ? undefined : Math.floor(created / 1000),
    lat: geo ? Number(geo[1]) : undefined,
    lon: geo ? Number(geo[2]) : undefined,
    rotation: Math.abs(Number(matrixRot ?? tags['rotate'] ?? 0)) % 360,
  };
}

/** True when the moov atom precedes mdat, i.e. the file streams progressively. */
async function probeFaststart(path: string): Promise<boolean> {
  const fh = await import('node:fs/promises').then((m) => m.open(path, 'r'));
  try {
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const head = buf.subarray(0, bytesRead);
    const moov = head.indexOf('moov');
    const mdat = head.indexOf('mdat');
    if (moov === -1) return false;          // moov not near the front
    return mdat === -1 || moov < mdat;
  } finally {
    await fh.close();
  }
}

/**
 * Lossless remux: stream copy, all metadata dropped, moov moved to the front.
 * Pixels and audio samples are bit-identical to the source — only the
 * container changes. This is also where video GPS is removed.
 */
export async function remuxFaststart(input: string): Promise<Buffer> {
  const out = join(tmpdir(), `ir-${randomUUID()}.mp4`);
  try {
    await run('ffmpeg', [
      '-v', 'error', '-i', input,
      '-map_metadata', '-1',        // drop GPS, device, software tags
      '-c', 'copy',                 // no re-encode
      '-movflags', '+faststart',
      '-y', out,
    ], { maxBuffer: MAX_BUFFER });
    return await readFile(out);
  } finally {
    await unlink(out).catch(() => {});
  }
}

/** Cached probe for VideoToolbox, Apple Silicon's hardware codec path. */
let hwSupport: boolean | null = null;
async function hasVideoToolbox(): Promise<boolean> {
  if (hwSupport !== null) return hwSupport;
  try {
    const { stdout } = await run('ffmpeg', ['-hide_banner', '-encoders'], { maxBuffer: MAX_BUFFER });
    hwSupport = stdout.includes('h264_videotoolbox');
  } catch {
    hwSupport = false;
  }
  return hwSupport;
}

const scaleFilter = `scale=-2:'min(${VIDEO_PREVIEW_HEIGHT},ih)'`;

/**
 * H.264 preview for clips the browser cannot play natively (HEVC) or that are
 * too large to stream comfortably to a phone on cellular.
 *
 * On Apple Silicon we hardware-decode AND hardware-encode. Measured on a 27s
 * 2688x1512 HEVC drone clip: 33.6s software vs 9.0s hardware. Most of that win
 * is the DECODE side — software HEVC decoding, not encoding, is the bottleneck.
 * The hardware encoder produces a file ~8% larger at the same resolution,
 * which is irrelevant for a preview stream.
 *
 * Falls back to libx264 if VideoToolbox is missing or errors on this input.
 */
export async function transcodePreview(input: string): Promise<Buffer> {
  if (await hasVideoToolbox()) {
    try {
      return await encodePreview(input, true);
    } catch {
      // Some inputs fail hardware decode (odd pixel formats, corrupt headers).
      // Silently fall through rather than lose the file.
    }
  }
  return encodePreview(input, false);
}

async function encodePreview(input: string, hw: boolean): Promise<Buffer> {
  const out = join(tmpdir(), `ir-prev-${randomUUID()}.mp4`);
  const args = hw
    ? ['-v', 'error', '-hwaccel', 'videotoolbox', '-i', input,
       '-map_metadata', '-1', '-vf', scaleFilter,
       '-c:v', 'h264_videotoolbox', '-b:v', '2500k',
       '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-y', out]
    : ['-v', 'error', '-i', input,
       '-map_metadata', '-1', '-vf', scaleFilter,
       '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24',
       '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-y', out];
  try {
    await run('ffmpeg', args, { maxBuffer: MAX_BUFFER });
    return await readFile(out);
  } finally {
    await unlink(out).catch(() => {});
  }
}

/** Grabs a frame for the poster. Seeks ~1s in to avoid black opening frames. */
export async function extractPoster(input: string, durationMs: number): Promise<Buffer> {
  const seek = durationMs > 2000 ? 1 : 0;
  const out = join(tmpdir(), `ir-post-${randomUUID()}.jpg`);
  try {
    await run('ffmpeg', [
      '-v', 'error', '-ss', String(seek), '-i', input,
      '-frames:v', '1', '-q:v', '3',
      '-y', out,
    ], { maxBuffer: MAX_BUFFER });
    return await readFile(out);
  } finally {
    await unlink(out).catch(() => {});
  }
}

/** Codecs Chrome/Firefox/Safari all play from a plain <video> tag. */
export function isWebPlayable(codec: string): boolean {
  return codec === 'h264' || codec === 'avc1';
}
