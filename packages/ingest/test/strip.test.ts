import sharp from 'sharp';
import exifr from 'exifr';
import { stripJpegMetadata } from '../src/jpeg.js';

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

/** List the APP marker numbers present in a JPEG. GPS lives in APP1 by spec. */
function appMarkers(buf: Buffer): number[] {
  const found: number[] = [];
  let p = 2;
  while (p < buf.length - 1) {
    if (buf[p] !== 0xff) break;
    const m = buf[p + 1];
    if (m === 0xff) { p++; continue; }
    if (m === 0xda || m === 0xd9) break;          // SOS / EOI
    const len = buf.readUInt16BE(p + 2);
    if (m >= 0xe0 && m <= 0xef) found.push(m - 0xe0);
    p += 2 + len;
  }
  return found;
}

/** Splice an APP1 segment carrying a real Exif header + payload into a JPEG. */
function injectApp1(jpeg: Buffer, payload: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), payload]);
  const seg = Buffer.alloc(4 + body.length);
  seg[0] = 0xff; seg[1] = 0xe1;
  seg.writeUInt16BE(body.length + 2, 2);
  body.copy(seg, 4);
  return Buffer.concat([jpeg.subarray(0, 2), seg, jpeg.subarray(2)]);
}

console.log('\nJPEG metadata stripping\n');

const base = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 30, g: 140, b: 90 } } })
  .jpeg({ quality: 88 })
  .toBuffer();

// --- 1. APP1 carrying a GPS-like payload is removed --------------------------
const secret = Buffer.from('GPSLatitude=15.4909;GPSLongitude=73.8278');
const tagged = injectApp1(base, secret);

check('fixture contains APP1', appMarkers(tagged).includes(1), `markers: ${appMarkers(tagged)}`);
check('fixture leaks coordinates', tagged.includes(secret));

const { buffer: clean, removedBytes, strippedSegments } = stripJpegMetadata(tagged);

check('APP1 removed', !appMarkers(clean).includes(1), `markers: ${appMarkers(clean)}`);
check('coordinate bytes gone from file', !clean.includes(secret));
check('reported the strip', strippedSegments.includes('APP1'), `${removedBytes} bytes`);

// --- 2. Pixels survive untouched --------------------------------------------
const pxBefore = await sharp(tagged).raw().toBuffer();
const pxAfter = await sharp(clean).raw().toBuffer();
check('pixels bit-identical', Buffer.compare(pxBefore, pxAfter) === 0);

// --- 3. ICC colour profile is preserved -------------------------------------
const withIcc = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#4080c0' } })
  .jpeg().withMetadata({ icc: 'srgb' }).toBuffer();
const iccTagged = injectApp1(withIcc, secret);
const iccClean = stripJpegMetadata(iccTagged).buffer;
check('ICC profile (APP2) kept', appMarkers(iccClean).includes(2), `markers: ${appMarkers(iccClean)}`);

// --- 4. Ordinary EXIF (camera tags) is also cleared -------------------------
const camera = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#111' } })
  .jpeg().withExif({ IFD0: { Make: 'Apple', Model: 'iPhone 14 Pro' } }).toBuffer();
check('fixture has camera EXIF', (await exifr.parse(camera, { ifd0: true }))?.Model === 'iPhone 14 Pro');
const camClean = stripJpegMetadata(camera).buffer;
check('camera EXIF cleared', !(await exifr.parse(camClean, { ifd0: true }).catch(() => null))?.Model);

// --- 5. Non-JPEG input is passed through, never corrupted -------------------
const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).png().toBuffer();
check('non-JPEG returned untouched', Buffer.compare(stripJpegMetadata(png).buffer, png) === 0);

// --- 6. Truncated input does not throw --------------------------------------
let threw = false;
try { stripJpegMetadata(base.subarray(0, 40)); } catch { threw = true; }
check('truncated JPEG handled safely', !threw);

console.log(`\n${failures === 0 ? 'all checks passed' : failures + ' FAILED'}\n`);
process.exit(failures === 0 ? 0 : 1);
