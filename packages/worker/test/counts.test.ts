// The counts and sort dates D1's triggers keep (migration 011), through every
// way a photo can join, move within, or leave an album.
import { makeWorld, seedMedia, addMedia, drift, check, finish } from './harness.js';

type World = ReturnType<typeof makeWorld>;

const w = makeWorld();
const count = (sql: string, ...args: unknown[]) => (w.sqlite.prepare(sql).get(...args) as { n: number }).n;
const albumN = (id: string) => count('SELECT item_count AS n FROM albums WHERE id = ?', id);
const folderN = (id: string) => count('SELECT item_count AS n FROM folders WHERE id = ?', id);
const inStep = (label: string, world: World = w) => {
  const off = drift(world);
  check(`${label}, and every count and sort date is in step`, off.length === 0, off.slice(0, 3).join('; '));
};

console.log('\ncounts and sort dates\n');

const trip = await seedMedia(w, 10, 'trip');
await seedMedia(w, 2, 'kids', 100);
check('an album counts what is added to it', albumN('trip') === 10 && albumN('kids') === 2);
inStep('new links carry their photo’s date');

const day1 = (await w.call('POST', '/admin/albums/trip/folders', { body: { title: 'Day 1' } })).json.id;
await w.call('POST', '/admin/albums/trip/folder-items', { body: { mediaIds: trip.slice(0, 4), folderId: day1 } });
check('a folder counts what is filed in it', folderN(day1) === 4 && albumN('trip') === 10);
inStep('filing');

await w.call('POST', '/admin/albums/kids/media', { body: { mediaIds: [trip[0], trip[9]] } });
check('moving to another album moves the counts', albumN('trip') === 8 && albumN('kids') === 4 && folderN(day1) === 3);
inStep('moving');

await w.call('POST', '/admin/albums/trip/folder-items', { body: { mediaIds: [trip[1]], folderId: null } });
check('taking one out of a folder', folderN(day1) === 2);
await w.call('DELETE', `/admin/albums/trip/folders/${day1}`);
inStep('deleting a folder sets its photos loose');

await w.call('DELETE', '/admin/albums/trip/media', { body: { mediaIds: [trip[2]] } });
check('removing from an album', albumN('trip') === 7);
await w.call('DELETE', '/admin/media', { body: { mediaIds: [trip[3]] } });
check('deleting a photo', albumN('trip') === 6);
inStep('removing and deleting');

// No date at first: it sorts by when it arrived, until a re-sent record has one.
const undated = 'c'.repeat(32);
await addMedia(w, [{ id: undated, kind: 'photo', ext: 'jpg', bytes: 1, width: 4, height: 3,
  origName: 'x.jpg', albums: ['trip'], derivatives: [] }]);
const arrived = count('SELECT sort_ts AS n FROM album_media WHERE media_id = ?', undated);
check('a photo with no date sorts by when it arrived', arrived > 1_700_000_000);
await addMedia(w, [{ id: undated, kind: 'photo', ext: 'jpg', bytes: 1, width: 4, height: 3, takenAt: 1_000,
  origName: 'x.jpg', albums: ['trip'], derivatives: [] }]);
check('and moves when it gets one', count('SELECT sort_ts AS n FROM album_media WHERE media_id = ?', undated) === 1_000);
inStep('a date arriving later');

// A known photo in no album, picked again in the uploader, is filed without uploading.
const start = await w.call('POST', '/admin/inbox/start', {
  body: { albumId: 'kids', files: [{ id: trip[2], name: 'IMG_2.jpg', size: 1000 }] },
});
check('a known photo picked again is filed', start.json.files[0].status === 'known' && albumN('kids') === 5);
inStep('filing from the uploader');

await w.call('DELETE', '/admin/albums/kids');
check('deleting an album leaves the others alone', albumN('trip') === 7);
inStep('deleting an album');

finish();
