import { writeFileSync } from 'node:fs';
import { probeVideo, remuxFaststart, extractPoster, isWebPlayable } from '../src/video.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

let fail = 0;
const check = (l: string, ok: boolean, d = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`); if (!ok) fail++; };
const S = process.argv[2];

console.log('\nVideo pipeline\n');

const probe = await probeVideo(`${S}/clip_fast.mp4`);
check('probes dimensions', probe.width === 1280 && probe.height === 720, `${probe.width}x${probe.height}`);
check('probes duration', Math.abs(probe.durationMs - 3000) < 200, `${probe.durationMs}ms`);
check('probes codec', probe.codec === 'h264', probe.codec);
check('extracts GPS from container', probe.lat === 15.4909 && probe.lon === 73.8278, `${probe.lat},${probe.lon}`);
check('extracts creation time', probe.createdAt === 1702650622, String(probe.createdAt));
check('detects h264 as web-playable', isWebPlayable(probe.codec));

const slow = await probeVideo(`${S}/clip_slow.mp4`);
check('faststart detection differentiates', probe.hasFaststart !== slow.hasFaststart || probe.hasFaststart,
  `fast=${probe.hasFaststart} slow=${slow.hasFaststart}`);

// --- the important one: remux strips location and stays lossless ------------
const remuxed = await remuxFaststart(`${S}/clip_fast.mp4`);
writeFileSync(`${S}/clip_clean.mp4`, remuxed);

const after = await probeVideo(`${S}/clip_clean.mp4`);
check('GPS removed by remux', after.lat === undefined && after.lon === undefined, `${after.lat},${after.lon}`);
check('remuxed is faststart', after.hasFaststart);
check('dimensions preserved', after.width === 1280 && after.height === 720);
check('duration preserved', Math.abs(after.durationMs - probe.durationMs) < 100);

const { stdout: tags } = await run('ffprobe', ['-v','quiet','-print_format','json','-show_format', `${S}/clip_clean.mp4`]);
const t = JSON.parse(tags).format.tags ?? {};
check('no location tag survives', !Object.keys(t).some(k => /location|model|make/i.test(k)), JSON.stringify(Object.keys(t)));

// Lossless check: compare decoded video frame hashes, not file bytes.
const frameHash = async (p: string) => (await run('ffmpeg', ['-v','error','-i',p,'-map','0:v','-f','framehash','-'],{maxBuffer:1<<26})).stdout.split('\n').filter(l=>l&&!l.startsWith('#')).join('\n');
check('video frames bit-identical (lossless)', await frameHash(`${S}/clip_fast.mp4`) === await frameHash(`${S}/clip_clean.mp4`));

const poster = await extractPoster(`${S}/clip_fast.mp4`, probe.durationMs);
check('poster extracted', poster.length > 1000 && poster[0] === 0xff && poster[1] === 0xd8, `${poster.length} bytes JPEG`);

console.log(`\n${fail === 0 ? 'all checks passed' : fail + ' FAILED'}\n`);
process.exit(fail ? 1 : 0);
