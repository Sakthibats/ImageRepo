// Share links limited to some folders, against an in-memory Worker.
import { makeWorld, seedMedia, check, finish } from './harness.js';

type World = ReturnType<typeof makeWorld>;

console.log('\nshare scope\n');

const w = makeWorld();
const trip = await seedMedia(w, 20, 'trip');
await seedMedia(w, 2, 'kids', 1000);

const folder = async (title: string, ids: string[]) => {
  const id = (await w.call('POST', '/admin/albums/trip/folders', { body: { title } })).json.id as string;
  if (ids.length) await w.call('POST', '/admin/albums/trip/folder-items', { body: { mediaIds: ids, folderId: id } });
  return id;
};
const A = await folder('Day 1', trip.slice(0, 5));
const B = await folder('Day 2', trip.slice(5, 10));
const C = await folder('Secret', trip.slice(10, 15));
// trip[15..19] stay loose.
const kidsFolder = (await w.call('POST', '/admin/albums/kids/folders', { body: { title: 'Other' } })).json.id;

async function share(body: Record<string, unknown>) {
  return w.call('POST', '/admin/shares', { body: { albumId: 'trip', ...body } });
}
async function open(world: World, token: string) {
  const r = await world.call('POST', `/s/${token}/session`, { auth: 'none' });
  const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
  return { ...r.json, status: r.status, cookie, raw: JSON.stringify(r.json) };
}
async function asset(token: string, cookie: string, id: string, tag: string) {
  return (await w.call('GET', `/s/${token}/a/${id}/320?t=${encodeURIComponent(tag)}`, { auth: 'none', cookie })).status;
}

const all = await share({});
const g = await open(w, all.json.token);
check('a link shares the whole album by default', all.json.scope === 'all' && g.count === 20 &&
  g.folders.map((f: any) => f.title).sort().join(',') === 'Day 1,Day 2,Secret', g.folders.map((f: any) => f.title).join(','));
check('guest items carry their folder', g.items.filter((i: any) => i.f === A).length === 5 && g.items.filter((i: any) => !i.f).length === 5);
check('guests still get no location', !/"(lat|lon|place)"/.test(g.raw));

const one = await share({ scope: 'folders', folderIds: [A] });
const g1 = await open(w, one.json.token);
check('a folder-only link shows just that folder', g1.count === 5 && g1.items.every((i: any) => i.f === A));
check('and names no other folder', g1.folders.length === 1 && !g1.raw.includes('Secret') && !g1.raw.includes('Day 2'));
check('guest "All photos" is oldest first', g1.items.map((i: any) => i.id).join() === trip.slice(0, 5).join());

const withLoose = await open(w, (await share({ scope: 'folders', folderIds: [A, B], includeLoose: true })).json.token);
check('folders plus loose photos', withLoose.count === 15 && withLoose.items.filter((i: any) => !i.f).length === 5);

const looseOnly = await open(w, (await share({ scope: 'folders', folderIds: [], includeLoose: true })).json.token);
check('loose photos alone', looseOnly.count === 5 && looseOnly.folders.length === 0);

const nothing = await share({ scope: 'folders', folderIds: [] });
check('a link must show something', nothing.status === 400);
const foreign = await share({ scope: 'folders', folderIds: [kidsFolder] });
check("another album's folder is refused", foreign.status === 400, String(foreign.status));
const bogus = await share({ scope: 'everything' });
check('an unknown scope is refused', bogus.status === 400);

// Assets: the tag is not enough on its own any more.
const inA = g1.items[0];
check('an item in scope loads', await asset(one.json.token, g1.cookie, inA.id, inA.t2) === 200);
const gB = g.items.find((i: any) => i.f === B);
check('a tag from another link does not open an item', await asset(one.json.token, g1.cookie, gB.id, gB.t2) === 403);

const allTok = all.json.token;
check('before the change, the whole-album link loads Day 2', await asset(allTok, g.cookie, gB.id, gB.t2) === 200);
const narrowed = await w.call('PATCH', `/admin/shares/${all.json.tokenHash}`, { body: { scope: 'folders', folderIds: [A] } });
check('a link can be narrowed without a new URL', narrowed.status === 200);
check('a folder taken out stops loading at once, even with a tag already issued',
  await asset(allTok, g.cookie, gB.id, gB.t2) === 403);
check('what is still shared keeps loading', await asset(allTok, g.cookie, inA.id, g.items.find((i: any) => i.id === inA.id).t2) === 200);
const reopened = await open(w, allTok);
check('and the guest list matches', reopened.count === 5 && reopened.folders.length === 1);

await w.call('PATCH', `/admin/shares/${all.json.tokenHash}`, { body: { scope: 'all' } });
check('widening back to everything works', (await open(w, allTok)).count === 20);

// Folders made after the link.
const D = await folder('Day 3', trip.slice(15, 17));
const later = await open(w, allTok);
const laterOne = await open(w, one.json.token);
check('a new folder appears on an everything link', later.folders.some((f: any) => f.id === D));
check('but stays private on a folder-only link', !laterOne.folders.some((f: any) => f.id === D) && laterOne.count === 5);

// A pinned cover outside what the guest can see falls back to one they can.
await w.call('PATCH', `/admin/albums/trip/folders/${A}`, { body: { coverId: trip[12] } });
const pinned = await open(w, one.json.token);
check('a cover from an unshared folder is not handed to a guest',
  pinned.folders[0].cover === trip[0] && !pinned.raw.includes(trip[12]));

await w.call('DELETE', `/admin/albums/trip/folders/${A}`);
const afterDelete = await open(w, one.json.token);
check('deleting its folder leaves a folder-only link showing nothing more', afterDelete.count === 0);

// The Day 1 + Day 2 + loose link lost Day 1 with the folder.
const list = await w.call('GET', '/admin/shares');
const listed = list.json.shares.find((s: any) =>
  s.scope === 'folders' && s.include_loose === 1 && s.folders.length === 1);
check('the share list says what each link shows', listed?.folders[0].title === 'Day 2', JSON.stringify(listed));

await w.call('POST', `/admin/shares/${one.json.tokenHash}/revoke`);
check('revoking stops assets at once', await asset(one.json.token, g1.cookie, inA.id, inA.t2) === 403);

// Links made before scopes existed.
w.sqlite.prepare(`INSERT INTO share_links (token_hash, album_id, created_at) VALUES ('old', 'kids', 0)`).run();
const old = w.sqlite.prepare(`SELECT scope, include_loose FROM share_links WHERE token_hash = 'old'`).get() as any;
check('an existing link keeps sharing everything', old.scope === 'all' && old.include_loose === 1);

finish();
