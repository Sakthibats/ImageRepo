// End-to-end checks of the stage runner and the `add` flow, against an
// in-memory bucket and a fake Worker. No network, no real ledger.
import sharp from 'sharp';
import exifr from 'exifr';
import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MediaRecord } from '@imagerepo/shared';
import { collect, addFiles, resolveAlbum, type AlbumApi } from '../src/add.js';
import { runFiles, type Storage } from '../src/runner.js';
import { openLedger, fileState } from '../src/ledger.js';
import { STAGES } from '../src/stages/index.js';
import type { IngestState } from '../src/state.js';

const run = promisify(execFile);
let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

// ------------------------------------------------------------- fixtures
const root = mkdtempSync(join(tmpdir(), 'imagerepo-run-'));
const lib = join(root, 'Holiday Pics');
mkdirSync(join(lib, 'Goa 2023'), { recursive: true });
mkdirSync(join(lib, 'Kids'), { recursive: true });

const gps = {
  GPSLatitudeRef: 'N', GPSLatitude: '15/1 29/1 2724/100',
  GPSLongitudeRef: 'E', GPSLongitude: '73/1 49/1 4008/100',
};
const photo = (colour: string) => sharp({ create: { width: 1600, height: 1200, channels: 3, background: colour } });
const exifTags = { IFD0: { Make: 'Apple', Model: 'iPhone 14 Pro' }, IFD3: gps };

await photo('#c0392b').jpeg().withExif(exifTags).toFile(join(lib, 'Goa 2023', 'IMG_20231215_143001.jpg'));
await photo('#2980b9').png().withExif(exifTags).toFile(join(lib, 'Goa 2023', 'beach.png'));
await photo('#27ae60').jpeg().withExif(exifTags).toFile(join(lib, 'loose.jpg'));
copyFileSync(join(lib, 'Goa 2023', 'IMG_20231215_143001.jpg'), join(lib, 'Kids', 'same-photo.jpg'));
writeFileSync(join(lib, 'Goa 2023', 'notes.txt'), 'not a photo');

const hasSips = process.platform === 'darwin' && await run('sips', ['--version']).then(() => true, () => false);
if (hasSips) {
  const tmp = join(root, 'h.jpg');
  await photo('#8e44ad').jpeg().withExif(exifTags).toFile(tmp);
  await run('sips', ['-s', 'format', 'heic', tmp, '--out', join(lib, 'Goa 2023', 'phone.heic')]);
}
await run('ffmpeg', ['-v', 'error',
  '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=3',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
  '-metadata', 'location=+15.4909+073.8278/',
  '-metadata', 'creation_time=2023-12-15T14:30:22Z',
  '-y', join(lib, 'Goa 2023', 'clip.mp4')]);

const expected = hasSips ? 6 : 5;

// ---------------------------------------------------------------- fakes
class FakeBucket implements Storage {
  objects = new Map<string, Buffer>();
  puts: string[] = [];
  looks = 0;
  /** Throw on every put after this many, to simulate the connection dropping. */
  failAfter = Infinity;
  async exists(key: string) { this.looks++; return this.objects.has(key); }
  async put(key: string, body: Buffer) {
    if (this.puts.length >= this.failAfter) throw new Error('connection reset');
    this.puts.push(key);
    this.objects.set(key, body);
  }
}
class FakeWorker implements AlbumApi {
  configured = true;
  down = false;
  calls = 0;
  records: MediaRecord[] = [];
  albums = new Map<string, string>();
  baked: string[] = [];
  async recordMedia(records: MediaRecord[]) {
    if (this.down) throw new Error('503 Service Unavailable');
    this.calls++;
    this.records.push(...records);
  }
  async ensureAlbums(albums: { id: string; title: string }[]) { for (const a of albums) this.albums.set(a.id, a.title); }
  async listAlbums() { return { albums: [...this.albums].map(([id, title]) => ({ id, title })) }; }
  async bake(album?: string) { this.baked.push(album ?? '*'); }
}

const states = (state: IngestState) => {
  const runs = state.runs();
  const out: Record<string, number> = {};
  for (const f of state.files()) {
    const s = fileState(f, f.hash ? runs.get(f.hash) : undefined);
    out[s] = (out[s] ?? 0) + 1;
  }
  return out;
};
const quiet = { out: () => {}, progress: () => {} };

const bucket = new FakeBucket();
const worker = new FakeWorker();
const state = openLedger(join(root, 'ledger', 'state.db'));
const deps = { state, storage: bucket, api: worker, ...quiet };

// ------------------------------------------------------------- collecting
console.log('\nFinding files\n');

const found = await collect([lib]);
check('finds photos and videos, ignores the rest', found.files.length === expected, `${found.files.length} files`);
const albumOf = (name: string) => found.files.find((f) => f.path.endsWith(name))?.album;
check('a subfolder becomes an album', albumOf('beach.png') === 'goa-2023');
check('loose files take the folder\'s own name', albumOf('loose.jpg') === 'holiday-pics');

const single = await collect([join(lib, 'Kids', 'same-photo.jpg'), join(lib, 'Goa 2023', 'notes.txt'), join(lib, 'nope.jpg')]);
check('a single file uses its parent folder', single.files[0]?.album === 'kids');
check('non-media and missing paths are reported', single.ignored.length === 1 && single.missing.length === 1);
check('an album name matches an existing title, not a new slug',
  resolveAlbum('summer trip', [{ id: 'goa-2023', title: 'Summer Trip' }]).id === 'goa-2023');

// ---------------------------------------------------------------- dry run
console.log('\nDry run, then the real run\n');

const dry = await addFiles(found, { dryRun: true }, deps);
// One file is a byte-for-byte copy of another, so it is "linked", not "added".
check('dry run reports every file', dry?.counts.added === expected - 1 && dry?.counts.linked === 1,
  JSON.stringify(dry?.counts));
check('dry run uploads nothing', bucket.objects.size === 0 && worker.calls === 0);
check('dry run leaves every file still to do', states(state).pending === expected, JSON.stringify(states(state)));

// ------------------------------------------------- interrupted, then resumed
bucket.failAfter = 4;
const broken = await addFiles(found, { yes: true, concurrency: 1 }, deps);
check('an interrupted run reports failures', (broken?.counts.failed ?? 0) > 0, JSON.stringify(broken?.counts));
check('...and records nothing it did not finish',
  worker.records.every((r) => bucket.objects.has(`orig/${r.id}.${r.ext}`)));
const putsBefore = bucket.puts.length;

bucket.failAfter = Infinity;
const resumed = await addFiles(found, { yes: true }, deps);
check('re-running finishes the job', resumed?.counts.failed === 0 && states(state).recorded === expected,
  JSON.stringify(resumed?.counts));
check('no object was uploaded twice', new Set(bucket.puts).size === bucket.puts.length,
  `${putsBefore} before, ${bucket.puts.length} total`);

// ------------------------------------------------------------- idempotence
const [looks, puts, calls] = [bucket.looks, bucket.puts.length, worker.calls];
const again = await addFiles(found, { yes: true }, deps);
check('a second run changes nothing', again?.counts.unchanged === expected, JSON.stringify(again?.counts));
check('...without touching storage or the Worker',
  bucket.looks === looks && bucket.puts.length === puts && worker.calls === calls);

// ---------------------------------------------------------------- privacy
console.log('\nWhat was stored\n');

const latest = new Map<string, MediaRecord>();
for (const r of worker.records) latest.set(`${r.id}|${r.albums[0]}`, r);
const records = [...latest.values()];
const byName = (n: string) => records.find((r) => r.origName === n)!;

for (const name of ['IMG_20231215_143001.jpg', 'beach.png', ...(hasSips ? ['phone.heic'] : [])]) {
  const r = byName(name);
  const stored = bucket.objects.get(`orig/${r.id}.${r.ext}`)!;
  const meta = await exifr.parse(stored, { gps: true, tiff: true }).catch(() => null);
  check(`${name}: stored original has no location`, Boolean(stored) && !meta?.longitude && !meta?.Model);
  check(`${name}: location kept for the database`, r.lon === 73.8278 && r.lat === 15.4909, `${r.lat},${r.lon}`);
  check(`${name}: full camera metadata kept`, (r.rawMeta as any)?.Model === 'iPhone 14 Pro');
  check(`${name}: all sizes uploaded`, r.derivatives.join() === '320,1024' &&
    r.derivatives.every((d) => bucket.objects.has(`drv/${r.id}/${d}.avif`)), r.derivatives.join());
}

const clip = byName('clip.mp4');
const clipPath = join(root, 'stored.mp4');
writeFileSync(clipPath, bucket.objects.get(`orig/${clip.id}.mp4`)!);
const { stdout } = await run('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', clipPath]);
check('video: stored original has no location', !/15\.4909/.test(stdout));
check('video: location kept for the database', clip.lat === 15.4909 && clip.lon === 73.8278);
check('video: poster and sizes uploaded', clip.derivatives[0] === 'poster' && bucket.objects.has(`post/${clip.id}.jpg`), clip.derivatives.join());
check('date comes from the filename when EXIF has none', byName('IMG_20231215_143001.jpg').takenAt === 1702650601);
check('every record names its stages', records.every((r) => r.stages?.length === STAGES[r.kind].length));

// ------------------------------------------------------------- duplicates
console.log('\nDuplicates and albums\n');

const a = byName('IMG_20231215_143001.jpg');
const b = byName('same-photo.jpg');
check('identical files share one upload', a.id === b.id &&
  bucket.puts.filter((k) => k.startsWith(`orig/${a.id}`)).length === 1);
check('...but are filed in both albums', a.albums[0] === 'goa-2023' && b.albums[0] === 'kids');

const refiled = await collect([join(lib, 'loose.jpg')], { album: { id: 'favourites', title: 'Favourites' } });
const moved = await addFiles(refiled, { yes: true }, deps);
check('adding a known photo to another album re-sends only the record',
  moved?.counts.linked === 1 && bucket.puts.length === puts, JSON.stringify(moved?.counts));
check('...and refreshes that album', worker.baked.at(-1) === 'favourites');

// -------------------------------------------------------------- Worker down
console.log('\nWhen the database is unreachable\n');

const offline = openLedger(join(root, 'ledger2', 'state.db'));
const bucket2 = new FakeBucket();
worker.down = true;
const held = await addFiles(await collect([join(lib, 'Kids')]), { yes: true }, { ...deps, state: offline, storage: bucket2 });
check('uploads are kept and reported as held', held?.counts.held === 1 && bucket2.objects.size > 0, JSON.stringify(held?.counts));
check('...and the ledger says so', states(offline).uploaded === 1, JSON.stringify(states(offline)));

worker.down = false;
const putsHeld = bucket2.puts.length;
const flushed = await runFiles(offline.files(), { state: offline, storage: null, recorder: worker, opts: {}, recordOnly: true });
check('recording later needs no re-upload', flushed.counts.linked === 1 && bucket2.puts.length === putsHeld &&
  states(offline).recorded === 1, JSON.stringify(flushed.counts));
offline.close();

// ----------------------------------------------------------- confirmation
const bucket3 = new FakeBucket();
const fresh = openLedger(join(root, 'ledger3', 'state.db'));
const declined = await addFiles(await collect([lib]), {}, { ...deps, state: fresh, storage: bucket3, confirm: async () => false });
check('declining the prompt uploads nothing', declined === null && bucket3.objects.size === 0);
fresh.close();

// --------------------------------------------------------- adding a stage
console.log('\nChanging the pipeline\n');

const derivatives = STAGES.photo.find((s) => s.name === 'derivatives')!;
derivatives.version = 2;
const photos = found.files.filter((f) => f.kind === 'photo').length;
check('bumping a stage version makes its backlog', states(state).pending === photos, JSON.stringify(states(state)));

const [looks2, sent2] = [bucket.looks, worker.records.length];
const redo = await addFiles(await collect([lib]), { yes: true }, deps);
const resent = worker.records.slice(sent2);
check('only that stage re-runs', redo!.counts.added + redo!.counts.linked === photos && bucket.looks > looks2 &&
  !bucket.puts.slice(puts).some((k) => k.startsWith('orig/')), JSON.stringify(redo?.counts));
check('videos are left alone', redo?.counts.unchanged === 1);
check('records carry the new version', resent.length > 0 &&
  resent.every((r) => r.stages?.find((s) => s.name === 'derivatives')?.version === 2));
derivatives.version = 1;
state.close();

// --------------------------------------------------------- old ledgers
console.log('\nLedgers from before stages\n');

const oldPath = join(root, 'old', 'state.db');
mkdirSync(join(root, 'old'));
const old = new Database(oldPath);
old.exec(`CREATE TABLE files (path TEXT PRIMARY KEY, album TEXT NOT NULL, album_title TEXT, kind TEXT NOT NULL,
  size INTEGER NOT NULL, mtime INTEGER NOT NULL, hash TEXT, status TEXT NOT NULL DEFAULT 'pending',
  error TEXT, derivatives TEXT, record TEXT, updated_at INTEGER)`);
const ins = old.prepare(`INSERT INTO files (path, album, kind, size, mtime, hash, status, record) VALUES (?,?,?,?,?,?,?,?)`);
const rec = (id: string, kind: string) => JSON.stringify({
  id, kind, ext: kind === 'photo' ? 'jpg' : 'mp4', bytes: 10, width: 4, height: 3, thumbhash: 'x',
  origName: 'f', albums: ['trip'], derivatives: kind === 'photo' ? ['320'] : ['poster', '320', 'preview'],
});
ins.run('/x/done.jpg', 'trip', 'photo', 10, 1, 'a'.repeat(32), 'recorded', rec('a'.repeat(32), 'photo'));
ins.run('/x/done.mp4', 'trip', 'video', 10, 1, 'b'.repeat(32), 'recorded', rec('b'.repeat(32), 'video'));
ins.run('/x/held.jpg', 'trip', 'photo', 10, 1, 'c'.repeat(32), 'uploaded', rec('c'.repeat(32), 'photo'));
ins.run('/x/dry.jpg', 'trip', 'photo', 10, 1, 'd'.repeat(32), 'processed', rec('d'.repeat(32), 'photo'));
old.close();

const converted = openLedger(oldPath);
const convRuns = converted.runs();
const st = (p: string) => {
  const f = converted.files([p])[0];
  return fileState(f, convRuns.get(f.hash!));
};
check('finished files stay finished', st('/x/done.jpg') === 'recorded' && st('/x/done.mp4') === 'recorded');
check('uploaded-but-unrecorded stays that way', st('/x/held.jpg') === 'uploaded');
check('a dry run is no longer mistaken for an upload', st('/x/dry.jpg') === 'pending');
converted.close();

console.log(`\n${failures === 0 ? 'all checks passed' : failures + ' FAILED'}\n`);
process.exit(failures === 0 ? 0 : 1);
