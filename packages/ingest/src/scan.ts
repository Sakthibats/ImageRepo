import { readdir, stat } from 'node:fs/promises';
import { join, extname, basename, relative, sep } from 'node:path';

const PHOTO_EXT = new Set(['.jpg', '.jpeg', '.heic', '.heif', '.png']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v']);

// Noise that shows up in any real photo folder.
const IGNORE_DIR = new Set(['.git', '.DS_Store', '@eaDir', '.thumbnails', 'node_modules']);
const IGNORE_FILE = /^(\._|\.DS_Store|Thumbs\.db)/i;

export interface ScannedFile {
  path: string;
  album: string;       // slug derived from folder structure
  albumTitle: string;  // human-readable original folder name
  kind: 'photo' | 'video';
  size: number;
  mtime: number;
}

export function slugify(s: string): string {
  return s
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'untitled';
}

/**
 * Walks the library root and derives an album from each file's folder path.
 *
 * `depth` controls how many path segments form the album:
 *   depth 1 (default)  "Trips/Kerala 2024/Day 1" -> album "Trips"
 *   depth 2            -> album "Trips / Kerala 2024"
 *   depth 0            -> the full path, one album per leaf folder
 *
 * A flat library (the common case) is unaffected by the setting. Files loose
 * at the root go to 'unsorted'.
 */
export async function scanLibrary(root: string, depth = 1): Promise<ScannedFile[]> {
  const out: ScannedFile[] = [];

  async function walk(dir: string) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;                                   // unreadable dir: skip, don't abort
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.isDirectory()) continue;
      if (IGNORE_DIR.has(e.name)) continue;
      const full = join(dir, e.name);

      if (e.isDirectory()) { await walk(full); continue; }
      if (!e.isFile() || IGNORE_FILE.test(e.name)) continue;

      const ext = extname(e.name).toLowerCase();
      const kind = PHOTO_EXT.has(ext) ? 'photo' : VIDEO_EXT.has(ext) ? 'video' : null;
      if (!kind) continue;

      const rel = relative(root, dir);
      const parts = rel ? rel.split(sep).filter(Boolean) : [];
      const used = depth > 0 ? parts.slice(0, depth) : parts;
      const albumTitle = used.length ? used.join(' / ') : 'Unsorted';
      const album = used.length ? slugify(used.join('-')) : 'unsorted';

      let s;
      try { s = await stat(full); } catch { continue; }

      out.push({
        path: full,
        album,
        albumTitle,
        kind,
        size: s.size,
        mtime: Math.floor(s.mtimeMs / 1000),
      });
    }
  }

  await walk(root);
  return out;
}

export function summarise(files: ScannedFile[]) {
  const byAlbum = new Map<string, { title: string; photos: number; videos: number; bytes: number }>();
  for (const f of files) {
    const cur = byAlbum.get(f.album) ?? { title: f.albumTitle, photos: 0, videos: 0, bytes: 0 };
    if (f.kind === 'photo') cur.photos++; else cur.videos++;
    cur.bytes += f.size;
    byAlbum.set(f.album, cur);
  }
  return byAlbum;
}
