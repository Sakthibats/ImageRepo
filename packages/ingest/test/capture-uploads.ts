// Intercepts what the pipeline would PUT to R2 and writes it to disk so we can
// inspect the real bytes with exiftool/ffprobe.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { scanLibrary } from '../src/scan.js';
import { processFile } from '../src/pipeline.js';
import { hashFile } from '../src/hash.js';
import type { FileRow } from '../src/state.js';

const [, , libRoot, outRoot] = process.argv;
const captured: string[] = [];

const fakeR2: any = {
  exists: async () => false,
  put: async (key: string, body: Buffer) => {
    const dest = join(outRoot, key);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, body);
    captured.push(key);
  },
};

for (const f of await scanLibrary(libRoot)) {
  const row: FileRow = { ...f, hash: await hashFile(f.path), status: 'pending', error: null, derivatives: null };
  await processFile(row, fakeR2, {});      // note: NOT dryRun — real put path
}
console.log(`captured ${captured.length} objects`);
