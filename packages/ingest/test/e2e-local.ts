// The real CLI flow against a real Worker and database — but a local one.
// Storage is an in-memory bucket: the CLI writes R2 over the S3 API, which a
// local Worker does not expose.
//
//   cd packages/worker
//   npx wrangler d1 execute imagerepo --local --file=../../schema.sql   (and each migration)
//   npx wrangler dev --local --var ADMIN_TOKEN:test
//   E2E_API=http://127.0.0.1:8787 E2E_TOKEN=test npx tsx ../ingest/test/e2e-local.ts
import sharp from 'sharp';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdminApi } from '../src/api.js';
import { addFiles, collect } from '../src/add.js';
import { openLedger } from '../src/ledger.js';
import type { Storage } from '../src/runner.js';

const apiUrl = process.env.E2E_API;
const adminToken = process.env.E2E_TOKEN;
if (!apiUrl || !adminToken) { console.error('set E2E_API and E2E_TOKEN'); process.exit(2); }
if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(apiUrl)) {
  console.error('refusing to run against anything but a local Worker'); process.exit(2);
}

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};
const get = async (path: string) =>
  (await fetch(apiUrl + path, { headers: { authorization: `Bearer ${adminToken}` } })).json() as Promise<any>;

const root = mkdtempSync(join(tmpdir(), 'imagerepo-e2e-'));
const lib = join(root, 'Trip');
mkdirSync(lib);
const tags = {
  IFD0: { Model: 'iPhone 14 Pro' },
  IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '15/1 29/1 2724/100', GPSLongitudeRef: 'E', GPSLongitude: '73/1 49/1 4008/100' },
};
for (const [i, c] of ['#c0392b', '#2980b9', '#27ae60'].entries()) {
  await sharp({ create: { width: 1200, height: 900, channels: 3, background: c } })
    .jpeg().withExif(tags).toFile(join(lib, `IMG_2023121${i + 1}_120000.jpg`));
}

const objects = new Map<string, Buffer>();
const storage: Storage = {
  exists: async (k) => objects.has(k),
  put: async (k, b) => { objects.set(k, b); },
};
const api = new AdminApi({ apiUrl, adminToken } as any);
const state = openLedger(join(root, 'state.db'));
const deps = { state, storage, api, out: () => {}, progress: () => {} };

console.log('\nCLI against a local Worker\n');

const before = (await get('/admin/health')).media as number;
const first = await addFiles(await collect([lib]), { yes: true }, deps);
check('three photos added', first?.counts.added === 3, JSON.stringify(first?.counts));
check('database has three more rows', (await get('/admin/health')).media === before + 3);

const album = (await get('/admin/albums')).albums.find((a: any) => a.id === 'trip');
check('album created with its folder name', album?.title === 'Trip' && album?.n === 3, JSON.stringify(album));
check('album was baked, so the web app can see it', Boolean(album?.manifest_ver));

const index = await get('/a/manifest/index');
const listed = index.albums?.find((a: any) => a.id === 'trip');
const manifest = await get(`/a/manifest/album/trip/${listed?.ver}`);
check('owner manifest lists the photos, with location', manifest.items?.length === 3 && manifest.items[0].lon === 73.8278);

const summary = await get('/admin/stages/summary');
const done = (stage: string) => summary.stages.find((s: any) => s.stage === stage && s.state === 'done')?.n;
check('each stage is recorded as done', done('exif') >= 3 && done('original') >= 3 && done('derivatives') >= 3,
  JSON.stringify(summary.stages));

const none = await get('/admin/stages/pending?stage=derivatives&version=1&kind=photo');
check('no photo is waiting on an existing stage', none.items.length === 0, `${none.items.length} pending`);
const future = await get('/admin/stages/pending?stage=tag&version=1');
check('a stage that does not exist yet has the whole library as its backlog', future.items.length === before + 3,
  `${future.items.length} pending`);
const bumped = await get('/admin/stages/pending?stage=derivatives&version=2&limit=2');
check('so does a bumped version, and it pages', bumped.items.length === 2 && Boolean(bumped.next));

const report = await fetch(apiUrl + '/admin/stages/report', {
  method: 'POST',
  headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
  body: JSON.stringify({ runner: 'e2e', items: [
    { mediaId: future.items[0].id, stage: 'tag', version: 1, state: 'done' },
    { mediaId: 'f'.repeat(32), stage: 'tag', version: 1, state: 'done' },     // not a real media id
  ] }),
});
check('a runner can report a stage', report.ok && (await get('/admin/stages/pending?stage=tag&version=1')).items.length === before + 2);

const again = await addFiles(await collect([lib]), { yes: true }, deps);
check('second run is a no-op', again?.counts.unchanged === 3 && (await get('/admin/health')).media === before + 3);

const unauth = await fetch(apiUrl + '/admin/stages/summary');
check('stage endpoints need the admin token', unauth.status === 401);

state.close();
console.log(`\n${failures === 0 ? 'all checks passed' : failures + ' FAILED'}\n`);
process.exit(failures === 0 ? 0 : 1);
