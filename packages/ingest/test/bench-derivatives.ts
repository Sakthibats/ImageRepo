// Times the derivatives stage on real photos, current code vs alternatives.
//   npx tsx test/bench-derivatives.ts <folder> [files=8] [concurrency=4]
// Reads the photos; writes nothing.
import sharp from 'sharp';
import pLimit from 'p-limit';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cpus } from 'node:os';
import { processPhoto, makeThumbHash } from '../src/photo.js';

const [dir, nArg, cArg] = process.argv.slice(2);
const n = Number(nArg ?? 8), conc = Number(cArg ?? 4);
const files = readdirSync(dir).filter((f) => /\.jpe?g$/i.test(f)).slice(0, n).map((f) => join(dir, f));
const inputs = files.map((f) => readFileSync(f));
const WIDTHS = [320, 1024, 2048];
const Q: Record<number, number> = { 320: 55, 1024: 58, 2048: 62 };

/** Decode once at 2048, derive the smaller sizes from that. */
async function decodeOnce(input: Buffer, effort: number, format: 'avif' | 'webp') {
  const meta = await sharp(input, { failOn: 'none' }).metadata();
  const big = await sharp(input, { failOn: 'none' }).rotate()
    .resize({ width: 2048, withoutEnlargement: true }).raw().toBuffer({ resolveWithObject: true });
  const raw = { raw: { width: big.info.width, height: big.info.height, channels: big.info.channels } } as const;
  const out: number[] = [];
  for (const w of WIDTHS) {
    let img = sharp(big.data, raw).resize({ width: w, withoutEnlargement: true });
    img = format === 'avif' ? img.avif({ quality: Q[w], effort }) : img.webp({ quality: 80, effort: 4 });
    out.push((await img.toBuffer()).length);
  }
  await makeThumbHash(await sharp(big.data, raw).resize(100, 100, { fit: 'inside' }).png().toBuffer());
  return { w: meta.width, bytes: out };
}

const variants: [string, (b: Buffer) => Promise<{ bytes: number[] }>][] = [
  ['processPhoto (as shipped)', async (b) => ({ bytes: (await processPhoto(b)).derivatives.map((d) => d.body.length) })],
  ['decode once, AVIF effort 4 (old)', (b) => decodeOnce(b, 4, 'avif')],
  ['decode once, AVIF effort 2', (b) => decodeOnce(b, 2, 'avif')],
  ['decode once, AVIF effort 0', (b) => decodeOnce(b, 0, 'avif')],
  ['decode once, WebP', (b) => decodeOnce(b, 4, 'webp')],
];

console.log(`\n${files.length} photos, ${(inputs.reduce((a, b) => a + b.length, 0) / files.length / 1048576).toFixed(1)}MB avg, ` +
  `${conc} at a time, ${cpus().length} cores, libvips threads ${sharp.concurrency()}\n`);
for (const [name, fn] of variants) {
  const limit = pLimit(conc);
  const t0 = Date.now();
  const sizes = await Promise.all(inputs.map((b) => limit(() => fn(b))));
  const secs = (Date.now() - t0) / 1000;
  const kb = (i: number) => Math.round(sizes.reduce((a, s) => a + (s.bytes[i] ?? 0), 0) / sizes.length / 1024);
  console.log(`  ${name.padEnd(36)} ${(secs / files.length).toFixed(2)}s/photo  ${(files.length / secs * 60).toFixed(0).padStart(4)}/min   sizes ${kb(0)}/${kb(1)}/${kb(2)} KB`);
}
console.log();
