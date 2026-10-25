// Owner listings read live from D1: pages, scopes, album and folder summaries.
import { makeWorld, seedMedia, addMedia, planOf, check, finish } from './harness.js';

type World = ReturnType<typeof makeWorld>;

/** Every page of a listing, following `next`. */
async function all(w: World, query: string, limit = 7) {
  const items: any[] = [];
  let after = '';
  let pages = 0;
  do {
    const r = await w.call('GET', `/a/media?${query}&limit=${limit}${after ? `&after=${after}` : ''}`);
    if (r.status !== 200) throw new Error(`${query}: ${r.status}`);
    items.push(...r.json.items);
    after = r.json.next ?? '';
    pages++;
  } while (after && pages < 100);
  return { items, ids: items.map((i) => i.id), pages };
}

console.log('\nlistings\n');

const w = makeWorld();
const trip = await seedMedia(w, 30, 'trip');
const kids = await seedMedia(w, 4, 'kids', 100);
// A burst: four photos in the same second, which pages must neither repeat nor skip.
const burst = ['e1', 'e2', 'e3', 'e4'].map((p) => p.padEnd(32, '0'));
await addMedia(w, burst.map((id) => ({ id, kind: 'photo' as const, ext: 'jpg', bytes: 1, width: 4, height: 3,
  takenAt: 1_700_000_600, origName: `${id}.jpg`, albums: ['trip'], derivatives: [] })));

const album = await all(w, 'album=trip');
const byDate = [...trip, ...burst].sort((a, b) => {
  const t = (id: string) => burst.includes(id) ? 1_700_000_600 : 1_700_000_000 + trip.indexOf(id) * 60;
  return t(a) - t(b) || a.localeCompare(b);
});
check('an album pages oldest first, with no repeats or gaps across a burst',
  album.ids.join() === byDate.join() && album.pages === 5, `${album.ids.length} items in ${album.pages} pages`);
const newest = await all(w, 'album=trip&order=desc');
check('and newest first', newest.ids.join() === [...byDate].reverse().join());
check('the owner sees location', album.items[0].place === 'Goa' && album.items[0].lat === 15.49);
check('items carry what the grid needs', album.items[0].w === 400 && album.items[0].h === 300 && album.items[0].t > 0);

const plan = planOf(w, /FROM album_media am JOIN media m/);
check('an album page is one index range, not a sort of the album',
  /idx_am_album_sort/.test(plan) && !/TEMP B-TREE/.test(plan), plan);

const day1 = (await w.call('POST', '/admin/albums/trip/folders', { body: { title: 'Day 1' } })).json.id;
await w.call('POST', '/admin/albums/trip/folder-items', { body: { mediaIds: trip.slice(5, 15), folderId: day1 } });
const folder = await all(w, `album=trip&folder=${day1}`);
check('a folder lists only its photos', folder.ids.join() === trip.slice(5, 15).join() &&
  folder.items.every((i) => i.f === day1));
const folderPlan = planOf(w, /am\.folder_id = \?/);
check('a folder page is one index range too', /idx_am_folder_sort/.test(folderPlan) && !/TEMP B-TREE/.test(folderPlan), folderPlan);
const loose = await all(w, 'album=trip&folder=loose');
check('loose lists the photos in no folder', loose.ids.length === 24 && loose.items.every((i) => !i.f));
check('a bad folder id is refused', (await w.call('GET', '/a/media?album=trip&folder=../x')).status === 400);

const library = await all(w, 'x=1', 500);
check('the library lists everything', library.ids.length === 38);
const libPlan = planOf(w, /FROM media m\s+(WHERE|ORDER)/);
check('a library page is one index range', /idx_media_sort/.test(libPlan) && !/TEMP B-TREE/.test(libPlan), libPlan);

await w.call('POST', '/admin/tags/apply', { body: { mediaIds: [trip[1], trip[2], kids[0]], add: ['beach'] } });
await w.call('POST', '/admin/tags/apply', { body: { mediaIds: [trip[2], trip[3]], add: ['sunset'] } });
check('tags: both', (await all(w, 'tags=beach,sunset')).ids.join() === trip[2]);
check('tags: either', (await all(w, 'tags=beach,sunset&match=any')).ids.join() === [trip[1], trip[2], trip[3], kids[0]].join());
check('tags: one, across albums', (await all(w, 'tags=Beach')).ids.length === 3);

const albums = (await w.call('GET', '/a/albums')).json.albums;
const t = albums.find((a: any) => a.id === 'trip');
check('the album list counts and covers each album', t.n === 34 && t.cover === trip[0] &&
  t.newest === 1_700_000_000 + 29 * 60, JSON.stringify(t));
check('albums are listed by title', albums.map((a: any) => a.id).join() === 'kids,trip');
await w.call('PATCH', '/admin/albums/trip', { body: { coverId: trip[7] } });
check('a chosen cover wins', (await w.call('GET', '/a/albums')).json.albums.find((a: any) => a.id === 'trip').cover === trip[7]);

const detail = (await w.call('GET', '/a/albums/trip')).json;
check('an open album says how many are loose', detail.n === 34 && detail.loose === 24 && detail.folders.length === 1);
check('and summarises its folders', detail.folders[0].n === 10 && detail.folders[0].cover === trip[5] &&
  detail.folders[0].newest === 1_700_000_000 + 14 * 60, JSON.stringify(detail.folders[0]));
check('an unknown album is 404', (await w.call('GET', '/a/albums/nope')).status === 404);

check('guests cannot list', (await w.call('GET', '/a/media?album=trip', { auth: 'none' })).status === 401 &&
  (await w.call('GET', '/a/albums', { auth: 'none' })).status === 401);
const live = await w.call('GET', '/a/albums');
check('listings are never cached', live.headers.get('cache-control') === 'private, no-store');

finish();
