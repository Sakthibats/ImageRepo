// Folders inside albums, against an in-memory Worker.
import { makeWorld, seedMedia, addMedia, check, finish } from './harness.js';

type World = ReturnType<typeof makeWorld>;

/** The owner's current baked manifest for an album, as the app reads it. */
async function manifest(w: World, album: string) {
  const index = await w.call('GET', '/a/manifest/index');
  const ver = index.json.albums.find((a: any) => a.id === album)?.ver;
  return (await w.call('GET', `/a/manifest/album/${album}/${ver}`)).json;
}

console.log('\nfolders\n');

const w = makeWorld();
const trip = await seedMedia(w, 120, 'trip');
await seedMedia(w, 3, 'kids', 1000);
const r2Before = w.bucket.keys().filter((k) => !k.startsWith('man/'));

const day1 = await w.call('POST', '/admin/albums/trip/folders', { body: { title: 'Day 1' } });
check('a folder is created', day1.status === 200 && /^[0-9a-f]{12}$/.test(day1.json.id), JSON.stringify(day1.json));
const dup = await w.call('POST', '/admin/albums/trip/folders', { body: { title: 'day 1' } });
check('folder names are unique within an album, ignoring case', dup.status === 409);
const other = await w.call('POST', '/admin/albums/kids/folders', { body: { title: 'Day 1' } });
check('the same name is fine in another album', other.status === 200);
const day2 = await w.call('POST', '/admin/albums/trip/folders', { body: { title: 'Day 2' } });
await w.call('POST', '/admin/albums/trip/folders', { body: { title: 'Later' } });
const missing = await w.call('POST', '/admin/albums/nope/folders', { body: { title: 'x' } });
check('a folder needs a real album', missing.status === 404);

let m = await manifest(w, 'trip');
check('a new album view has every photo loose', m.items.every((i: any) => !i.f) && m.folders.length === 3);

// More than one D1 chunk, to check the move is not cut short.
const mv = await w.call('POST', '/admin/albums/trip/folder-items', {
  body: { mediaIds: trip.slice(0, 95), folderId: day1.json.id },
});
check('photos move into a folder', mv.json.moved === 95, JSON.stringify(mv.json));
await w.call('POST', '/admin/albums/trip/folder-items', { body: { mediaIds: trip.slice(95, 110), folderId: day2.json.id } });

m = await manifest(w, 'trip');
const f1 = m.folders.find((f: any) => f.id === day1.json.id);
const f2 = m.folders.find((f: any) => f.id === day2.json.id);
check('items carry their folder', m.items.filter((i: any) => i.f === day1.json.id).length === 95 &&
  m.items.filter((i: any) => !i.f).length === 10);
check('folders are counted', f1.n === 95 && f2.n === 15);
check('a folder cover defaults to its earliest photo', f1.cover === trip[0] && !f1.coverPinned && f2.cover === trip[95]);
check('folders are listed most recent first, empty ones leading',
  m.folders.map((f: any) => f.title).join(',') === 'Later,Day 2,Day 1', m.folders.map((f: any) => f.title).join(','));
check('the album still lists all its photos', m.count === 120);

const cross = await w.call('POST', '/admin/albums/kids/folder-items', { body: { mediaIds: [trip[0]], folderId: day1.json.id } });
check("another album's folder is refused", cross.status === 404);

const pin = await w.call('PATCH', `/admin/albums/trip/folders/${day1.json.id}`, { body: { coverId: trip[115] } });
m = await manifest(w, 'trip');
check('a cover can be any photo in the album', pin.status === 200 &&
  m.folders.find((f: any) => f.id === day1.json.id).cover === trip[115] &&
  m.folders.find((f: any) => f.id === day1.json.id).coverPinned === true);
const outside = await w.call('PATCH', `/admin/albums/trip/folders/${day1.json.id}`, { body: { coverId: '0'.repeat(28) + '03e8' } });
check('but not a photo from another album', outside.status === 400, String(outside.status));
await w.call('PATCH', `/admin/albums/trip/folders/${day1.json.id}`, { body: { coverId: null } });
m = await manifest(w, 'trip');
check('clearing the cover goes back to the earliest photo', m.folders.find((f: any) => f.id === day1.json.id).cover === trip[0]);

const rn = await w.call('PATCH', `/admin/albums/trip/folders/${day2.json.id}`, { body: { title: 'Beach day' } });
const rnClash = await w.call('PATCH', `/admin/albums/trip/folders/${day2.json.id}`, { body: { title: 'DAY 1' } });
m = await manifest(w, 'trip');
check('a folder can be renamed', rn.status === 200 && m.folders.some((f: any) => f.title === 'Beach day'));
check('not onto another folder name', rnClash.status === 409);

// Recording a photo again (say after a stage version bump) must not undo sorting.
await addMedia(w, [{ id: trip[0], kind: 'photo', ext: 'jpg', bytes: 1000, width: 400, height: 300,
  origName: 'IMG_0.jpg', albums: ['trip'], derivatives: ['320', '1024', '2048'] }]);
await w.call('POST', '/admin/bake', { body: { album: 'trip' } });
m = await manifest(w, 'trip');
check('a re-sent record keeps its folder', m.items.find((i: any) => i.id === trip[0]).f === day1.json.id);

await w.call('POST', '/admin/albums/trip/folder-items', { body: { mediaIds: [trip[1]], folderId: null } });
m = await manifest(w, 'trip');
check('a photo can go back to loose', !m.items.find((i: any) => i.id === trip[1]).f);

await w.call('POST', '/admin/albums/kids/media', { body: { mediaIds: [trip[2]] } });
const kids = await manifest(w, 'kids');
check('a photo moved to another album arrives loose', kids.items.some((i: any) => i.id === trip[2] && !i.f));
check('and leaves the album it was in', !(await manifest(w, 'trip')).items.some((i: any) => i.id === trip[2]) &&
  (w.sqlite.prepare(`SELECT COUNT(*) AS n FROM album_media WHERE media_id = ?`).get(trip[2]) as any).n === 1);
const twice = await w.call('POST', '/admin/albums/kids/media', { body: { mediaIds: [trip[2]] } });
check('moving it into the album it is in changes nothing', twice.status === 200 &&
  (await manifest(w, 'kids')).items.some((i: any) => i.id === trip[2]));
let second = true;
try { w.sqlite.prepare(`INSERT INTO album_media (album_id, media_id) VALUES ('trip', ?)`).run(trip[2]); }
catch { second = false; }
check('D1 itself refuses a second album for a photo', !second);

const del = await w.call('DELETE', `/admin/albums/trip/folders/${day1.json.id}`);
m = await manifest(w, 'trip');
check('deleting a folder keeps its photos, loose', del.status === 200 && m.count === 119 &&
  m.items.filter((i: any) => !i.f).length === 104 && !m.folders.some((f: any) => f.id === day1.json.id));

check('no object in R2 moved', JSON.stringify(w.bucket.keys().filter((k) => !k.startsWith('man/'))) === JSON.stringify(r2Before));

const list = await w.call('GET', '/admin/albums/trip/folders');
check('folders can be listed with counts', list.json.folders.length === 2 &&
  list.json.folders.find((f: any) => f.title === 'Beach day').n === 15, JSON.stringify(list.json));

await w.call('DELETE', '/admin/albums/trip');
const left = (w.sqlite.prepare(`SELECT COUNT(*) AS n FROM folders WHERE album_id = 'trip'`).get() as any).n;
check("deleting an album deletes its folders", left === 0);

finish();
