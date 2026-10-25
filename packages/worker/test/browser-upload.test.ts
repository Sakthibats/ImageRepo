// The web app's uploader (packages/web/src/upload.ts) against this Worker's
// inbox routes and a fake R2: what a browser does, end to end.
import { createHash } from 'node:crypto';
import { makeWorld, seedMedia, addMedia, accessJwt, check, finish, PREPROCESS_CLIENT_ID } from './harness.js';
import { uploadFiles, hashFile, type Api, type Put } from '../../web/src/upload.ts';

type World = ReturnType<typeof makeWorld>;
const MiB = 1024 * 1024;
const service = { jwt: await accessJwt({ common_name: PREPROCESS_CLIENT_ID, sub: '' }) };

function apiFor(w: World): Api {
  const ok = async (r: Promise<{ status: number; json: any }>) => {
    const res = await r;
    if (res.status !== 200) throw new Error(res.json?.error ?? String(res.status));
    return res.json;
  };
  return {
    start: (albumId, files, folderId) => ok(w.call('POST', '/admin/inbox/start', { body: { albumId, files, folderId } })),
    parts: (id, partNumbers) => ok(w.call('POST', '/admin/inbox/parts', { body: { id, partNumbers } })),
    finish: (ids) => ok(w.call('POST', '/admin/inbox/finish', { body: { ids } })),
  };
}

/** What XMLHttpRequest does, through the fake R2's S3 endpoint. */
const fetchPut: Put = async (url, body, onBytes) => {
  const res = await fetch(url, { method: 'PUT', body: new Uint8Array(await body.arrayBuffer()) });
  if (!res.ok) throw new Error(`storage answered ${res.status}`);
  onBytes(body.size);
};

const file = (name: string, bytes: Uint8Array) => new File([bytes], name, { lastModified: 1_700_000_000_000 });
const noise = (n: number, seed: number) => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i += 997) b[i] = (i * seed) % 251;
  b[0] = seed;
  return b;
};
const idOf = (b: Uint8Array) => createHash('sha256').update(b).digest('hex').slice(0, 32);
const count = (w: World, sql: string) => (w.sqlite.prepare(sql).get() as { n: number }).n;

console.log('\nbrowser upload, end to end\n');

const w = makeWorld();
await seedMedia(w, 1, 'kids');
await seedMedia(w, 1, 'trip', 50);
const folder = (await w.call('POST', '/admin/albums/trip/folders', { body: { title: 'Day 1' } })).json.id;
const api = apiFor(w);

const a = noise(5000, 1), b = noise(6000, 2), c = noise(7000, 3), k = noise(4000, 4);
// One the library already has, in another album: refused.
await addMedia(w, [{
  id: idOf(k), kind: 'photo', ext: 'jpg', bytes: k.length, width: 4, height: 3,
  origName: 'old.jpg', albums: ['kids'], derivatives: ['320'],
}]);

check('hashing in the browser gives the library’s ids, small files and large',
  await hashFile(new Blob([a])) === idOf(a) && await hashFile(new Blob([noise(40 * MiB, 9)])) === idOf(noise(40 * MiB, 9)));

{
  let expired = true;
  const flaky: Put = async (url, body, onBytes) => {
    // The first URL for b.HEIC has gone stale by the time it is used.
    if (expired && url.includes(idOf(b))) { expired = false; throw new Error('storage answered 403'); }
    return fetchPut(url, body, onBytes);
  };
  const states: number[] = [];
  const state = await uploadFiles(
    [file('a.jpg', a), file('b.HEIC', b), file('c.png', c), file('a copy.jpg', a), file('old.jpg', k)],
    { albumId: 'trip', folderId: folder },
    (s) => states.push(s.bytesSent),
    { api, put: flaky },
  );
  check('every new file is uploaded and queued', state.sent === 3, JSON.stringify(state));
  check('the same file picked twice goes up once', state.files === 4);
  check('a file in another album is not uploaded, and is reported as being there',
    state.failed.length === 1 && state.failed[0].name === 'old.jpg' && state.failed[0].error === 'already in “kids”' &&
    count(w, `SELECT COUNT(*) AS n FROM album_media WHERE media_id = '${idOf(k)}' AND album_id = 'kids'`) === 1,
    JSON.stringify(state.failed));
  check('a stale URL is replaced and the file still goes up', !expired && w.bucket.objects.has(`inbox/${idOf(b)}.heic`));
  check('progress reaches every byte sent', state.bytesSent === state.bytes && state.bytes === a.length + b.length + c.length,
    `${state.bytesSent} / ${state.bytes}`);
  check('bytes arrive intact', w.bucket.objects.get(`inbox/${idOf(c)}.png`)?.length === c.length);
  check('they wait for the service, filed for this album and folder',
    count(w, `SELECT COUNT(*) AS n FROM uploads WHERE state = 'ready' AND album_id = 'trip' AND folder_id = '${folder}'`) === 3);
}

console.log('\na large video, interrupted and resumed\n');
{
  const big = noise(70 * MiB + 5, 7);
  const clip = () => file('clip.MOV', big);
  let sentParts = 0;
  // The page closes after two parts.
  const dying: Put = async (url, body, onBytes) => {
    if (sentParts >= 2) throw new Error('network error');
    sentParts++;
    return fetchPut(url, body, onBytes);
  };
  const first = await uploadFiles([clip()], { albumId: 'trip' }, () => {}, { api, put: dying });
  check('an interrupted upload is reported, not queued', first.failed.length === 1 && first.sent === 0,
    JSON.stringify(first.failed));

  let resumedBytes = 0;
  const counting: Put = async (url, body, onBytes) => { resumedBytes += body.size; return fetchPut(url, body, onBytes); };
  const again = await uploadFiles([clip()], { albumId: 'trip' }, () => {}, { api, put: counting });
  check('picking it again sends only the parts that are missing', again.sent === 1 &&
    resumedBytes === big.length - 2 * 16 * MiB, `${resumedBytes}`);
  const stored = w.bucket.objects.get(`inbox/${idOf(big)}.mov`);
  check('and R2 ends up with the whole file', stored?.length === big.length && idOf(stored!) === idOf(big));
}

console.log('\nprocessing\n');
{
  // The service takes everything and records it.
  const claim = await w.call('POST', '/admin/inbox/claim', { auth: service, body: { limit: 10 } });
  const records = [];
  for (const it of claim.json.items) {
    const ext = it.kind === 'video' ? 'mp4' : it.ext;
    await w.bucket.put(`orig/${it.id}.${ext}`, 'stripped');
    records.push({ id: it.id, kind: it.kind, ext, bytes: 8, width: 4, height: 3, origName: it.origName,
      albums: [], derivatives: ['320'] });
  }
  await w.call('POST', '/admin/inbox/complete', { auth: service, body: { records } });

  const summary = (await w.call('GET', '/admin/inbox/summary?album=trip')).json;
  check('the album has nothing left to process once the service is done',
    !summary.counts.ready && !summary.counts.claimed && !summary.albums.trip, JSON.stringify(summary.counts));
  check('everything uploaded is in the album, the picked photos in their folder',
    count(w, `SELECT COUNT(*) AS n FROM album_media WHERE album_id = 'trip' AND folder_id = '${folder}'`) === 3 &&
    count(w, `SELECT COUNT(*) AS n FROM uploads`) === 0 && !w.bucket.keys('inbox/').length);
}

console.log('\nmany files\n');
{
  const batches: number[] = [];
  const watched: Api = { ...api, start: (albumId, files, folderId) => { batches.push(files.length); return api.start(albumId, files, folderId); } };
  const many = Array.from({ length: 30 }, (_, i) => file(`m${i}.jpg`, noise(3000 + i, 100 + i)));
  const s = await uploadFiles(many, { albumId: 'kids' }, () => {}, { api: watched, put: fetchPut });
  check('the first files are in the queue before the rest have hashed, and all of them go up',
    batches[0] < 25 && batches.reduce((n, b) => n + b, 0) === 30 && s.sent === 30, batches.join(','));
}

finish();
