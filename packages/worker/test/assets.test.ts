// Serving a media item's files: the owner's /a route and guests' /s route.
import type { MediaRecord } from '@imagerepo/shared';
import { makeWorld, addMedia, check, finish } from './harness.js';

const w = makeWorld();
const hex = (n: number) => n.toString(16).padStart(32, '0');
const [narrow, tiny, wide, h264, hevc] = [1, 2, 3, 4, 5].map(hex);

const photo = (id: string, width: number): Partial<MediaRecord> => ({
  id, kind: 'photo', ext: 'jpg', bytes: 1, width, height: Math.round(width * 2 / 3),
  takenAt: 1_700_000_000, origName: `${id}.jpg`, albums: ['trip'], derivatives: [],
});
const clip = (id: string): Partial<MediaRecord> => ({
  id, kind: 'video', ext: 'mp4', bytes: 1, width: 1280, height: 720, durationMs: 3000,
  takenAt: 1_700_000_000, origName: `${id}.mov`, albums: ['trip'], derivatives: [],
});
await addMedia(w, [photo(narrow, 1800), photo(tiny, 300), photo(wide, 4032), clip(h264), clip(hevc)]);
// What the service writes: sizes up to each photo's width, the smallest always.
for (const [id, sizes] of [[narrow, [320, 1024]], [tiny, [320]], [wide, [320, 1024, 2048]]] as const) {
  for (const s of sizes) await w.bucket.put(`drv/${id}/${s}.avif`, `${id}@${s}`);
}
await w.bucket.put(`orig/${h264}.mp4`, 'h264 original');
await w.bucket.put(`orig/${hevc}.mp4`, 'hevc original');
// Only HEVC gets a preview: H.264 plays everywhere as it is.
await w.bucket.put(`prev/${hevc}.mp4`, 'hevc preview');

/** What a path serves. The fake R2 holds strings, so the body is the key's content. */
async function served(path: string, o: { auth?: 'none'; cookie?: string } = {}) {
  const r = await w.call('GET', path, o);
  return { status: r.status, type: r.headers.get('content-type'), body: r.text };
}

console.log('\nserving files\n');

const a = await served(`/a/${narrow}/2048`);
check('a photo narrower than the size asked for is served the largest it has',
  a.status === 200 && a.body === `${narrow}@1024` && a.type === 'image/avif', `${a.status} ${a.body}`);
check('the sizes it has are served as asked', (await served(`/a/${narrow}/1024`)).body === `${narrow}@1024`);
check('a tiny one gets its thumbnail for any size', (await served(`/a/${tiny}/2048`)).body === `${tiny}@320`);
check('a large one gets the size asked for', (await served(`/a/${wide}/2048`)).body === `${wide}@2048`);

const plain = await served(`/a/${h264}/preview`);
check('a video with no preview plays its MP4 original', plain.status === 200 &&
  plain.body === 'h264 original' && plain.type === 'video/mp4', `${plain.status} ${plain.body}`);
check('one with a preview plays that', (await served(`/a/${hevc}/preview`)).body === 'hevc preview');

const link = (await w.call('POST', '/admin/shares', { body: { albumId: 'trip' } })).json;
const session = await w.call('POST', `/s/${link.token}/session`, { auth: 'none' });
const cookie = (session.headers.get('set-cookie') ?? '').split(';')[0];
const items = (await w.call('GET', `/s/${link.token}/media`, { auth: 'none', cookie })).json.items;
const tag = (id: string) => encodeURIComponent(items.find((i: any) => i.id === id).t2);
const g = await served(`/s/${link.token}/a/${narrow}/2048?t=${tag(narrow)}`, { auth: 'none', cookie });
check('guests get the same', g.status === 200 && g.body === `${narrow}@1024`, `${g.status} ${g.body}`);
const gv = await served(`/s/${link.token}/a/${h264}/preview?t=${tag(h264)}`, { auth: 'none', cookie });
check('videos included', gv.status === 200 && gv.body === 'h264 original' && gv.type === 'video/mp4');

finish();
