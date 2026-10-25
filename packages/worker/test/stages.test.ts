// Re-running stages over media already in the library (stages.ts).
import type { MediaRecord } from '@imagerepo/shared';
import { makeWorld, addMedia, accessJwt, statementCount, ranSince, check, finish, PREPROCESS_CLIENT_ID } from './harness.js';
import { RERUNS_PER_DAY } from '../src/stages.js';

const service = { jwt: await accessJwt({ common_name: PREPROCESS_CLIENT_ID, sub: '' }) };
const w = makeWorld();
const hex = (n: number) => n.toString(16).padStart(32, '0');
const row = (sql: string, ...args: unknown[]) => w.sqlite.prepare(sql).get(...args) as any;

/** Media as an upload records it: every stage of its kind done at today's versions. */
const media = (i: number, kind: 'photo' | 'video', rawMeta?: Record<string, unknown>): Partial<MediaRecord> => ({
  id: hex(i), kind, ext: kind === 'video' ? 'mp4' : 'jpg', bytes: 1, width: 400, height: 300,
  takenAt: 1_700_000_000 + i, origName: `${i}`, albums: ['trip'], derivatives: [], rawMeta,
  stages: kind === 'photo'
    ? [{ name: 'exif', version: 2 }, { name: 'original', version: 1 }, { name: 'derivatives', version: 2 }]
    : [{ name: 'probe', version: 2 }, { name: 'original', version: 1 }, { name: 'poster', version: 1 }, { name: 'preview', version: 1 }],
});
await addMedia(w, [
  ...Array.from({ length: 12 }, (_, i) => media(i + 1, 'photo', i === 3 ? { Orientation: 6, GPSLatitude: 1 } : undefined)),
  ...Array.from({ length: 3 }, (_, i) => media(100 + i, 'video')),
]);

const claim = (body: Record<string, unknown>) =>
  w.call('POST', '/admin/stages/claim', { auth: service, body: { runner: 'laptop', ...body } });
const report = (items: unknown[]) => w.call('POST', '/admin/stages/report', { auth: service, body: { runner: 'laptop', items } });
const ids = (r: { json: any }) => r.json.items.map((i: any) => i.id);

console.log('\nre-running stages\n');

const current = await claim({ stage: 'derivatives', version: 2, kind: 'photo' });
check('nothing to do at the version uploads ran', current.json.items.length === 0 && current.json.done === true);
const mark = statementCount();
await claim({ stage: 'derivatives', version: 2, kind: 'photo' });
check('a finished pass is checked without reading the library',
  !ranSince(mark).some((s) => /FROM media m LEFT JOIN media_stages/.test(s)), ranSince(mark).length + ' statements');

const first = await claim({ stage: 'derivatives', version: 3, kind: 'photo', limit: 5 });
check('a new version hands out photos in id order, and no videos',
  ids(first).join() === [1, 2, 3, 4, 5].map(hex).join() && first.json.items.every((i: any) => i.kind === 'photo'), ids(first).join());
check('a photo the camera turned says so, and nothing else from its metadata',
  first.json.items[3].orientation === 6 && !('orientation' in first.json.items[0]) &&
  !JSON.stringify(first.json).includes('GPS'));
const place = row(`SELECT after FROM stage_sweeps WHERE stage = 'derivatives' AND version = 3`).after;
check('the pass keeps its place in D1, so a restarted service carries on', place === hex(5));
const second = await claim({ stage: 'derivatives', version: 3, kind: 'photo', limit: 5 });
const third = await claim({ stage: 'derivatives', version: 3, kind: 'photo', limit: 5 });
check('and nothing is handed out twice', ids(second).join() === [6, 7, 8, 9, 10].map(hex).join() &&
  ids(third).join() === [11, 12].map(hex).join());
check('the pass ends at the end of the library',
  row(`SELECT finished_at FROM stage_sweeps WHERE stage = 'derivatives' AND version = 3`).finished_at > 0 &&
  (await claim({ stage: 'derivatives', version: 3, kind: 'photo' })).json.items.length === 0);

const done = await report([
  { mediaId: hex(4), stage: 'derivatives', version: 3, state: 'done',
    fields: { width: 300, height: 400, thumbhash: 'YJqGPQw7sFlslqhFafSE+Q6oJ1h2iHB2Rw' }, rewrote: true },
  { mediaId: hex(5), stage: 'derivatives', version: 3, state: 'done' },
]);
const m4 = row(`SELECT width, height, thumbhash, rev FROM media WHERE id = ?`, hex(4));
check('a re-run updates what it produced, and its served files get a new revision',
  done.status === 200 && m4.width === 300 && m4.height === 400 && m4.thumbhash.startsWith('YJqG') && m4.rev === 1, JSON.stringify(m4));
check('one that rewrote nothing keeps its revision', row(`SELECT rev FROM media WHERE id = ?`, hex(5)).rev === 0);
check('and the stage is recorded at the new version',
  row(`SELECT version, state FROM media_stages WHERE media_id = ? AND stage = 'derivatives'`, hex(4)).state === 'done');

await report([{ mediaId: hex(6), stage: 'derivatives', version: 3, state: 'failed', error: 'R2 timed out' }]);
const failed = row(`SELECT state, attempts, lease_until - updated_at AS wait FROM media_stages WHERE media_id = ? AND stage = 'derivatives'`, hex(6));
check('a failure waits before it is retried', failed.state === 'failed' && failed.wait === 60, JSON.stringify(failed));
check('so it is not handed out at once', !ids(await claim({ stage: 'derivatives', version: 3, kind: 'photo' })).includes(hex(6)));
w.sqlite.prepare(`UPDATE media_stages SET lease_until = 0 WHERE media_id = ?`).run(hex(6));
const retry = await claim({ stage: 'derivatives', version: 3, kind: 'photo' });
check('but is once the wait is over, after the pass has finished', ids(retry).includes(hex(6)));
await report([{ mediaId: hex(6), stage: 'derivatives', version: 3, state: 'failed', error: 'no original', permanent: true }]);
w.sqlite.prepare(`UPDATE media_stages SET lease_until = 0 WHERE media_id = ?`).run(hex(6));
check('a permanent failure is not retried', !ids(await claim({ stage: 'derivatives', version: 3, kind: 'photo' })).includes(hex(6)));

// hex(7) was claimed and never reported: the service died.
w.sqlite.prepare(`UPDATE media_stages SET lease_until = 0 WHERE media_id = ? AND stage = 'derivatives'`).run(hex(7));
check('a claim that lapsed is handed out again', ids(await claim({ stage: 'derivatives', version: 3, kind: 'photo' })).includes(hex(7)));

const today = Math.floor(Date.now() / 86400_000);
w.sqlite.prepare(`UPDATE stage_sweeps SET claimed = ?, day = ? WHERE stage = 'derivatives' AND version = 3`)
  .run(RERUNS_PER_DAY - 1, today);
const near = await claim({ stage: 'poster', version: 2, kind: 'video', limit: 3 });
const over = await claim({ stage: 'poster', version: 2, kind: 'video', limit: 3 });
check('a day’s re-runs are capped across every pass', ids(near).length === 1 && over.json.capped === true && !over.json.items.length,
  `${ids(near).length}, ${JSON.stringify(over.json)}`);

const sweeps = (await w.call('GET', '/admin/stages/sweeps', { auth: service })).json;
const d3 = sweeps.sweeps.find((s: any) => s.stage === 'derivatives' && s.version === 3);
check('the service can see where each pass stands', d3.finishedAt > 0 && d3.failed === 1 &&
  sweeps.today === RERUNS_PER_DAY && sweeps.perDay === RERUNS_PER_DAY, JSON.stringify(sweeps));

// hex(4)'s served files were rewritten: every way to its URLs says so.
const page = (await w.call('GET', '/a/media?album=trip')).json.items;
check('the owner’s pages carry a rewritten photo’s revision, and only its',
  page.find((i: any) => i.id === hex(4)).r === 1 && page.filter((i: any) => i.r).length === 1);
await w.call('PATCH', '/admin/albums/trip', { body: { coverId: hex(4) } });
const folder = (await w.call('POST', '/admin/albums/trip/folders', { body: { title: 'Turned' } })).json.id;
await w.call('POST', '/admin/albums/trip/folder-items', { body: { mediaIds: [hex(4)], folderId: folder } });
const albumCover = (await w.call('GET', '/a/albums')).json.albums[0];
const detail = (await w.call('GET', '/a/albums/trip')).json;
check('and so do album and folder covers', albumCover.coverRev === 1 &&
  detail.folders.find((f: any) => f.id === folder).coverRev === 1, JSON.stringify(albumCover));
const link = (await w.call('POST', '/admin/shares', { body: { albumId: 'trip' } })).json;
const session = await w.call('POST', `/s/${link.token}/session`, { auth: 'none' });
const cookie = (session.headers.get('set-cookie') ?? '').split(';')[0];
const guestPage = (await w.call('GET', `/s/${link.token}/media`, { auth: 'none', cookie })).json.items;
check('and a guest’s', guestPage.find((i: any) => i.id === hex(4)).r === 1 &&
  session.json.folders.find((f: any) => f.id === folder).coverRev === 1);

check('a claim names its kind', (await claim({ stage: 'derivatives', version: 3 })).status === 400);
check('and a real version', (await claim({ stage: 'derivatives', version: 0, kind: 'photo' })).status === 400);
check('guests cannot claim', (await w.call('POST', '/admin/stages/claim', { auth: 'none', body: {} })).status === 401);

finish();
