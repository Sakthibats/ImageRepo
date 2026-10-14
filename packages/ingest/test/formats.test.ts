import sharp from 'sharp';
import exifr from 'exifr';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripPngMetadata } from '../src/png.js';
import { stripHeicMetadata } from '../src/heic.js';
import { stripMetadata } from '../src/strip.js';
import { decodableImage } from '../src/decode.js';
import { processPhoto } from '../src/photo.js';

const run = promisify(execFile);
let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};
const dir = mkdtempSync(join(tmpdir(), 'imagerepo-fmt-'));
const gps = {
  GPSLatitudeRef: 'N', GPSLatitude: '15/1 29/1 2724/100',
  GPSLongitudeRef: 'E', GPSLongitude: '73/1 49/1 4008/100',
};
const located = (b: Buffer | string) => exifr.parse(b, { gps: true, tiff: true }).catch(() => null);

// ------------------------------------------------------------------ PNG
console.log('\nPNG metadata stripping\n');

const png = await sharp({ create: { width: 320, height: 200, channels: 3, background: '#a53' } })
  .png().withExif({ IFD0: { Model: 'iPhone 14 Pro' }, IFD3: gps }).withMetadata({ icc: 'srgb' }).toBuffer();
const chunkTypes = (b: Buffer) => {
  const out: string[] = [];
  for (let p = 8; p + 12 <= b.length; p += 12 + b.readUInt32BE(p)) out.push(b.toString('latin1', p + 4, p + 8));
  return out;
};

check('fixture carries EXIF', chunkTypes(png).includes('eXIf'), chunkTypes(png).join(' '));
check('fixture leaks coordinates', (await located(png))?.longitude === 73.8278);

const pngClean = stripPngMetadata(png);
check('eXIf chunk removed', !chunkTypes(pngClean.buffer).includes('eXIf'), chunkTypes(pngClean.buffer).join(' '));
check('coordinates gone', !(await located(pngClean.buffer))?.longitude);
check('colour profile kept', chunkTypes(pngClean.buffer).includes('iCCP'));
check('pixels bit-identical', Buffer.compare(
  await sharp(png).raw().toBuffer(), await sharp(pngClean.buffer).raw().toBuffer()) === 0);

let threw = false;
try { stripPngMetadata(png.subarray(0, 60)); } catch { threw = true; }
check('truncated PNG is refused, not passed through', threw);

threw = false;
try { stripMetadata(Buffer.from('GIF89a'), 'gif'); } catch { threw = true; }
check('a format with no stripper is refused', threw);

// ----------------------------------------------------------------- HEIC
console.log('\nHEIC metadata stripping\n');

const hasSips = process.platform === 'darwin' && await run('sips', ['--version']).then(() => true, () => false);
if (!hasSips) {
  console.log('  SKIP  no HEIC encoder on this machine (needs macOS sips) — HEIC is untested here');
} else {
  const jpg = join(dir, 'src.jpg');
  const heicPath = join(dir, 'src.heic');
  await sharp({ create: { width: 640, height: 480, channels: 3, background: '#2a8' } })
    .composite([{ input: Buffer.from('<svg width="640" height="480"><circle cx="200" cy="200" r="150" fill="#f80"/></svg>') }])
    .jpeg({ quality: 95 }).withExif({ IFD0: { Make: 'Apple', Model: 'iPhone 14 Pro' }, IFD3: gps }).toFile(jpg);
  await run('sips', ['-s', 'format', 'heic', jpg, '--out', heicPath]);
  const heic = readFileSync(heicPath);

  const before = await located(heic);
  check('fixture leaks coordinates', before?.longitude === 73.8278, `lon=${before?.longitude}`);
  check('fixture carries camera model', before?.Model === 'iPhone 14 Pro');

  const clean = stripHeicMetadata(heic);
  check('reported the strip', clean.strippedSegments.includes('Exif'), `${clean.removedBytes} bytes`);
  check('file size and layout unchanged', clean.buffer.length === heic.length);
  check('input buffer not modified', (await located(heic))?.longitude === 73.8278);

  const after = await located(clean.buffer);
  check('coordinates gone', !after?.longitude && !after?.latitude, JSON.stringify(after ?? null));
  check('camera model gone', !after?.Model);
  check('no GPS tag bytes left', !clean.buffer.includes(Buffer.from('iPhone 14 Pro')));

  // Decode both with Apple's decoder and compare every pixel.
  const cleanPath = join(dir, 'clean.heic');
  writeFileSync(cleanPath, clean.buffer);
  const px = async (p: string) => sharp(await decodableImage(p, 'heic', readFileSync(p))).raw().toBuffer();
  const [a, b] = [await px(heicPath), await px(cleanPath)];
  check('still decodes after stripping', b.length > 0);
  check('pixels bit-identical', Buffer.compare(a, b) === 0, `${a.length} bytes compared`);

  const derived = await processPhoto(await decodableImage(cleanPath, 'heic', clean.buffer));
  check('HEIC can be resized for the grid', derived.width === 640 && derived.derivatives.length >= 1,
    `${derived.width}x${derived.height}, ${derived.derivatives.map((d) => d.name).join('/')}`);

  threw = false;
  try { stripHeicMetadata(heic.subarray(0, 200)); } catch { threw = true; }
  check('truncated HEIC is refused, not passed through', threw);
}

// --------------------------------------------------------- orientation
console.log('\nRotated photos\n');

// Stored landscape, but the camera says "turned 90°" — as cameras do for portrait shots.
const turned = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: '#888' } })
  .jpeg().withMetadata({ orientation: 6 }).toBuffer();
const upright = await processPhoto(turned);
check('dimensions are as the photo is seen', upright.width === 1600 && upright.height === 2400,
  `${upright.width}x${upright.height}`);
const big = await sharp(upright.derivatives.at(-1)!.body).metadata();
check('resized copies are upright', big.width === 1024 && big.height === 1536, `${big.width}x${big.height}`);

console.log(`\n${failures === 0 ? 'all checks passed' : failures + ' FAILED'}\n`);
process.exit(failures === 0 ? 0 : 1);
