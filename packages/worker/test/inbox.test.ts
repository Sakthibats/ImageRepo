// Browser uploads through presigned URLs, and the processing service's queue.
import {
  makeWorld, seedMedia, accessJwt, check, finish, s3State, PREPROCESS_CLIENT_ID,
} from './harness.js';

type World = ReturnType<typeof makeWorld>;

const service = { jwt: await accessJwt({ common_name: PREPROCESS_CLIENT_ID, sub: '' }) };
const MiB = 1024 * 1024;
const hex = (n: number) => n.toString(16).padStart(32, 'a');
const count = (w: World, sql: string) => (w.sqlite.prepare(sql).get() as { n: number }).n;

/** What the browser does with a presigned URL. */
const put = (url: string, bytes: Uint8Array) => fetch(url, { method: 'PUT', body: bytes });

/** The record the service sends back once it has written orig/ and drv/. */
async function processed(w: World, id: string, o: { ext?: string; albums?: string[] } = {}) {
  await w.bucket.put(`orig/${id}.${o.ext ?? 'jpg'}`, 'stripped');
  for (const s of [320, 1024, 2048]) await w.bucket.put(`drv/${id}/${s}.avif`, 'd');
  return {
    id, kind: 'photo', ext: o.ext ?? 'jpg', bytes: 8, width: 4000, height: 3000,
    takenAt: 1_700_000_000, lat: 15.5, lon: 73.8, origName: 'IMG.jpg',
    albums: o.albums ?? ['somewhere-else'], derivatives: ['320', '1024', '2048'],
    stages: [{ name: 'exif', version: 2 }, { name: 'original', version: 1 }, { name: 'derivatives', version: 2 }],
  };
}

async function manifestItems(w: World, album: string) {
  const index = await w.call('GET', '/a/manifest/index');
  const ver = index.json.albums.find((a: any) => a.id === album)?.ver;
  return (await w.call('GET', `/a/manifest/album/${album}/${ver}`)).json.items as any[];
}

console.log('\nbrowser uploads\n');

const w = makeWorld();
await seedMedia(w, 2, 'trip');
await seedMedia(w, 1, 'kids', 100);
const known = '0'.repeat(31) + '1';
const day1 = (await w.call('POST', '/admin/albums/kids/folders', { body: { title: 'Day 1' } })).json.id;

{
  const small = new Uint8Array(1000).fill(7);
  const start = await w.call('POST', '/admin/inbox/start', {
    body: {
      albumId: 'kids', folderId: day1, files: [
        { id: hex(1), name: 'IMG_1.HEIC', size: small.length, lastModified: 1_700_000_000_000 },
        { id: known, name: 'IMG_x.jpg', size: 1000 },
        { id: hex(2), name: 'notes.webp', size: 10 },
        { id: 'nope', name: 'a.jpg', size: 10 },
      ],
    },
  });
  const [f1, f2, f3, f4] = start.json.files;
  check('a new file gets a presigned URL for its inbox key', f1.status === 'upload' &&
    f1.url.includes(`/imagerepo/inbox/${hex(1)}.heic?`) && f1.url.includes('X-Amz-Signature=') &&
    f1.url.includes('X-Amz-Expires=3600'), JSON.stringify(f1));
  check('a file already in another album is refused, naming it',
    f2.status === 'refused' && f2.error === 'already in “trip”', JSON.stringify(f2));
  check('a type with no stripper is refused', f3.status === 'refused' && /webp/.test(f3.error));
  check('a bad id is refused', f4.status === 'refused');
  check('and it stays where it was', !(await manifestItems(w, 'kids')).some((i) => i.id === known) &&
    count(w, `SELECT COUNT(*) AS n FROM album_media WHERE media_id = '${known}' AND album_id = 'trip'`) === 1);

  await w.call('DELETE', '/admin/albums/trip/media', { body: { mediaIds: [known] } });
  const orphan = await w.call('POST', '/admin/inbox/start', {
    body: { albumId: 'kids', folderId: day1, files: [{ id: known, name: 'IMG_x.jpg', size: 1000 }] },
  });
  const items = await manifestItems(w, 'kids');
  check('a known file in no album is not uploaded but filed here, in the folder being viewed',
    orphan.json.files[0].status === 'known' && items.some((i) => i.id === known && i.f === day1),
    JSON.stringify(items));
  const back = await w.call('POST', '/admin/inbox/start', {
    body: { albumId: 'kids', files: [{ id: known, name: 'IMG_x.jpg', size: 1000 }] },
  });
  check('picking it again in its own album is a no-op', back.json.files[0].status === 'known');

  const early = await w.call('POST', '/admin/inbox/finish', { body: { ids: [hex(1)] } });
  check('finishing before anything is uploaded is an error, and the upload starts over',
    early.json.files[0].status === 'error' && count(w, 'SELECT COUNT(*) AS n FROM uploads') === 0);

  const again = await w.call('POST', '/admin/inbox/start', {
    body: { albumId: 'kids', folderId: day1, files: [{ id: hex(1), name: 'IMG_1.HEIC', size: small.length, lastModified: 1_700_000_000_000 }] },
  });
  const res = await put(again.json.files[0].url, small);
  check('the browser puts the bytes straight into R2', res.ok && w.bucket.objects.get(`inbox/${hex(1)}.heic`)?.length === 1000);
  check('nothing about it is in media or any album yet',
    count(w, `SELECT COUNT(*) AS n FROM media WHERE id = '${hex(1)}'`) === 0);

  const fin = await w.call('POST', '/admin/inbox/finish', { body: { ids: [hex(1)] } });
  check('a finished file is queued', fin.json.files[0].status === 'queued' &&
    count(w, `SELECT COUNT(*) AS n FROM uploads WHERE state = 'ready'`) === 1);
  const restart = await w.call('POST', '/admin/inbox/start', {
    body: { albumId: 'kids', files: [{ id: hex(1), name: 'IMG_1.HEIC', size: small.length }] },
  });
  check('picking it again while queued uploads nothing', restart.json.files[0].status === 'queued');
  const elsewhere = await w.call('POST', '/admin/inbox/start', {
    body: { albumId: 'trip', files: [{ id: hex(1), name: 'IMG_1.HEIC', size: small.length }] },
  });
  check('picking it in another album while queued is refused, naming the album it is going to',
    elsewhere.json.files[0].error === 'already being added to “kids”', JSON.stringify(elsewhere.json));
}

console.log('\nresuming\n');
{
  // Uploaded, but the tab closed before /finish.
  const start = await w.call('POST', '/admin/inbox/start', {
    body: { albumId: 'trip', files: [{ id: hex(3), name: 'b.jpg', size: 50 }] },
  });
  await put(start.json.files[0].url, new Uint8Array(50));
  const back = await w.call('POST', '/admin/inbox/start', {
    body: { albumId: 'trip', files: [{ id: hex(3), name: 'b.jpg', size: 50 }] },
  });
  check('a file whose bytes arrived but was never finished is queued on the next start',
    back.json.files[0].status === 'queued');

  const wrong = await w.call('POST', '/admin/inbox/start', {
    body: { albumId: 'trip', files: [{ id: hex(4), name: 'c.jpg', size: 50 }] },
  });
  await put(wrong.json.files[0].url, new Uint8Array(49));
  const fin = await w.call('POST', '/admin/inbox/finish', { body: { ids: [hex(4)] } });
  check('a file of the wrong size is refused and its bytes deleted',
    fin.json.files[0].error === 'uploaded size does not match' && !w.bucket.objects.has(`inbox/${hex(4)}.jpg`));

  const big = 70 * MiB + 123;
  const mp = await w.call('POST', '/admin/inbox/start', {
    body: { albumId: 'trip', files: [{ id: hex(5), name: 'clip.MOV', size: big }] },
  });
  const f = mp.json.files[0];
  check('a large file goes up in parts', f.status === 'upload' && f.partSize === 16 * MiB && f.partCount === 5 &&
    f.done.length === 0, JSON.stringify(f));

  const bytes = new Uint8Array(big);
  for (let i = 0; i < big; i += 4096) bytes[i] = i % 251;
  const part = (n: number) => bytes.subarray((n - 1) * f.partSize, Math.min(big, n * f.partSize));
  let urls = (await w.call('POST', '/admin/inbox/parts', { body: { id: hex(5), partNumbers: [1, 2, 3] } })).json.parts;
  for (const p of urls) await put(p.url, part(p.partNumber));

  const early = await w.call('POST', '/admin/inbox/finish', { body: { ids: [hex(5)] } });
  check('finishing with parts missing says which', early.json.files[0].error === 'parts missing' &&
    early.json.files[0].missing.join() === '4,5', JSON.stringify(early.json));

  const resumed = await w.call('POST', '/admin/inbox/start', {
    body: { albumId: 'trip', files: [{ id: hex(5), name: 'clip.MOV', size: big }] },
  });
  check('starting again reports the parts R2 already has', resumed.json.files[0].done.join() === '1,2,3');
  const outOfRange = await w.call('POST', '/admin/inbox/parts', { body: { id: hex(5), partNumbers: [6] } });
  check('part numbers past the end are refused', outOfRange.status === 400);

  urls = (await w.call('POST', '/admin/inbox/parts', { body: { id: hex(5), partNumbers: [4, 5] } })).json.parts;
  for (const p of urls) await put(p.url, part(p.partNumber));
  const done = await w.call('POST', '/admin/inbox/finish', { body: { ids: [hex(5)] } });
  const stored = w.bucket.objects.get(`inbox/${hex(5)}.mov`);
  check('the Worker assembles the parts and queues the file', done.json.files[0].status === 'queued' &&
    stored?.length === big && stored[4096 * 300] === bytes[4096 * 300], JSON.stringify(done.json));
}

console.log('\nprocessing service\n');
{
  const shares = await w.call('GET', '/admin/shares', { auth: service });
  const purge = await w.call('GET', '/admin/purge/summary', { auth: service });
  const del = await w.call('DELETE', '/admin/albums/trip', { auth: service });
  check('the service token cannot read shares, purge or delete', shares.status === 403 &&
    purge.status === 403 && del.status === 403, `${shares.status} ${purge.status} ${del.status}`);
  const health = await w.call('GET', '/admin/health', { auth: service });
  check('but can check health', health.status === 200);

  const photosOnly = await w.call('POST', '/admin/inbox/claim', { auth: service, body: { kinds: ['video'], limit: 0 } });
  check('a claim can ask for one kind only', photosOnly.json.items.length === 1 &&
    photosOnly.json.items[0].kind === 'video', JSON.stringify(photosOnly.json));
  w.sqlite.prepare(`UPDATE uploads SET state = 'ready', lease_until = NULL WHERE state = 'claimed'`).run();

  const claim = await w.call('POST', '/admin/inbox/claim', { auth: service, body: { runner: 'laptop', limit: 2, kinds: ['photo', 'video'] } });
  check('the service claims the oldest waiting files', claim.status === 200 && claim.json.items.length === 2 &&
    claim.json.items[0].id === hex(1) && claim.json.items[0].key === `inbox/${hex(1)}.heic` &&
    claim.json.items[0].lastModified === 1_700_000_000, JSON.stringify(claim.json));
  const second = await w.call('POST', '/admin/inbox/claim', { auth: service, body: { runner: 'other', limit: 5 } });
  check('a second instance gets the rest, not the same files',
    second.json.items.map((i: any) => i.id).join() === hex(5), JSON.stringify(second.json.items));

  const notYet = await w.call('POST', '/admin/inbox/complete', {
    auth: service, body: { records: [{ id: hex(1), kind: 'photo', ext: 'heic', albums: ['kids'] }] },
  });
  check('a record is refused until its original is in R2', notYet.json.skipped[0]?.reason === 'original not in R2');

  const rec = await processed(w, hex(1), { ext: 'heic' });
  const ok = await w.call('POST', '/admin/inbox/complete', { auth: service, body: { runner: 'laptop', records: [rec] } });
  check('the service records a processed file', ok.json.recorded === 1, JSON.stringify(ok.json));
  const items = await manifestItems(w, 'kids');
  check('it appears at once in the album it was dropped into, in its folder, not the album the record named',
    items.some((i) => i.id === hex(1) && i.f === day1) &&
    count(w, `SELECT COUNT(*) AS n FROM album_media WHERE album_id = 'somewhere-else'`) === 0);
  check('its upload row and raw inbox copy are gone', !w.bucket.objects.has(`inbox/${hex(1)}.heic`) &&
    count(w, `SELECT COUNT(*) AS n FROM uploads WHERE id = '${hex(1)}'`) === 0);
  check('its stages are recorded as done by the service', count(w,
    `SELECT COUNT(*) AS n FROM media_stages WHERE media_id = '${hex(1)}' AND state = 'done' AND runner = 'laptop'`) === 3);
  const dupe = await w.call('POST', '/admin/inbox/complete', { auth: service, body: { records: [rec] } });
  check('completing twice does nothing the second time', dupe.json.recorded === 0);

  // hex(3): fails four times and goes back in the queue each time, then gives up.
  const lease = () => w.sqlite.prepare(`UPDATE uploads SET lease_until = 0 WHERE state IN ('ready', 'claimed')`).run();
  const waits: number[] = [];
  for (let i = 1; i <= 5; i++) {
    await w.call('POST', '/admin/inbox/fail', { auth: service, body: { items: [{ id: hex(3), error: `boom ${i}` }] } });
    if (i < 5) {
      const row = w.sqlite.prepare(`SELECT lease_until - updated_at AS n FROM uploads WHERE id = '${hex(3)}'`).get() as { n: number };
      waits.push(row.n);
      if (i === 1) {
        const soon = await w.call('POST', '/admin/inbox/claim', { auth: service, body: { limit: 5 } });
        check('a failed file is not handed out again at once', !soon.json.items.some((x: any) => x.id === hex(3)),
          JSON.stringify(soon.json.items));
      }
      lease();
      const c = await w.call('POST', '/admin/inbox/claim', { auth: service, body: { limit: 1 } });
      if (c.json.items[0]?.id !== hex(3)) check(`retry ${i} is handed out again`, false, JSON.stringify(c.json));
    }
  }
  check('and waits longer after each failure', waits.join() === '60,300,1800,7200', waits.join());
  const summary = await w.call('GET', '/admin/inbox/summary', { auth: service });
  check('after five failures it is given up on, with its last error', summary.json.counts.failed === 1 &&
    summary.json.failed[0].error === 'boom 5' && summary.json.failed[0].attempts === 5, JSON.stringify(summary.json));

  lease();
  const reclaimed = await w.call('POST', '/admin/inbox/claim', { auth: service, body: { runner: 'third' } });
  check('a lapsed lease goes back in the queue', reclaimed.json.items.some((i: any) => i.id === hex(5)));
  await w.call('POST', '/admin/inbox/fail', {
    auth: service, body: { items: [{ id: hex(5), error: 'hash mismatch', permanent: true }] },
  });
  check('a permanent failure deletes the bytes at once', !w.bucket.objects.has(`inbox/${hex(5)}.mov`) &&
    count(w, `SELECT COUNT(*) AS n FROM uploads WHERE id = '${hex(5)}' AND state = 'failed'`) === 1);

  const albums = (await w.call('GET', '/admin/inbox/summary')).json.albums;
  check('the summary counts uploads per album', albums.trip?.failed === 2 && !albums.kids?.failed,
    JSON.stringify(albums));

  const denied = await w.call('POST', '/admin/inbox/retry', { auth: service, body: { ids: [hex(3)] } });
  check('the service cannot retry uploads', denied.status === 403, String(denied.status));
  const retried = await w.call('POST', '/admin/inbox/retry', { body: { ids: [hex(3), hex(5), hex(1)] } });
  check('a failed upload still in the inbox goes back in the queue, with fresh attempts',
    retried.json.retried === 1 &&
    count(w, `SELECT COUNT(*) AS n FROM uploads WHERE id = '${hex(3)}' AND state = 'ready' AND attempts = 0`) === 1,
    JSON.stringify(retried.json));
  check('one whose bytes are gone stays failed, counted as gone', retried.json.gone === 1 &&
    count(w, `SELECT COUNT(*) AS n FROM uploads WHERE id = '${hex(5)}' AND state = 'failed'`) === 1);

  const retry = await w.call('POST', '/admin/inbox/start', {
    body: { albumId: 'trip', files: [{ id: hex(5), name: 'clip.MOV', size: 70 * MiB + 123 }] },
  });
  check('picking a failed file again starts it over', retry.json.files[0].status === 'upload' &&
    count(w, `SELECT attempts AS n FROM uploads WHERE id = '${hex(5)}'`) === 0, JSON.stringify(retry.json));

  // hex(6): waiting longer than R2 keeps inbox/, so its bytes are gone.
  const old = await w.call('POST', '/admin/inbox/start', {
    body: { albumId: 'trip', files: [{ id: hex(6), name: 'd.jpg', size: 20 }] },
  });
  await put(old.json.files[0].url, new Uint8Array(20));
  await w.call('POST', '/admin/inbox/finish', { body: { ids: [hex(6)] } });
  await w.call('POST', '/admin/inbox/claim', { auth: service, body: { runner: 'laptop', limit: 50 } });
  await w.bucket.delete(`inbox/${hex(6)}.jpg`);
  const resend = await w.call('POST', '/admin/inbox/start', {
    body: { albumId: 'trip', files: [{ id: hex(6), name: 'd.jpg', size: 20 }] },
  });
  check('picking a waiting file whose bytes have expired asks for it again',
    resend.json.files[0].status === 'upload' && count(w,
      `SELECT COUNT(*) AS n FROM uploads WHERE id = '${hex(6)}' AND state = 'uploading' AND lease_until IS NULL`) === 1,
    JSON.stringify(resend.json));
  await w.call('POST', '/admin/inbox/fail', {
    auth: service, body: { items: [{ id: hex(6), error: 'no longer in storage', permanent: true }] },
  });
  check('and the service giving up on the old claim does not undo that',
    count(w, `SELECT COUNT(*) AS n FROM uploads WHERE id = '${hex(6)}' AND state = 'uploading'`) === 1);

  check('no location reaches the upload queue', !w.sqlite.prepare(`PRAGMA table_info(uploads)`).all()
    .some((col: any) => /lat|lon|place|gps|meta/.test(col.name)));
}

console.log('\nservice status\n');
{
  const status = async () => (await w.call('GET', '/admin/inbox/summary')).json.runners;
  check('no service has checked in yet', (await status()).length === 0);
  const hb = await w.call('POST', '/admin/inbox/heartbeat', {
    auth: service, body: { runner: 'laptop', kinds: ['photo', 'video'], busy: 3 },
  });
  let r = (await status())[0];
  check('a checked-in service is reported online, with what it takes', hb.status === 200 && r.online === true &&
    r.name === 'laptop' && r.kinds.join() === 'photo,video' && r.busy === 3, JSON.stringify(r));
  w.sqlite.prepare(`UPDATE runners SET last_seen = last_seen - 61`).run();
  r = (await status())[0];
  check('one that has not checked in for a minute is offline', r.online === false);
  await w.call('POST', '/admin/inbox/heartbeat', { auth: service, body: { runner: 'laptop', kinds: ['photo'] } });
  await w.call('POST', '/admin/inbox/heartbeat', { auth: service, body: { runner: 'laptop', kinds: ['photo'], stopping: true } });
  r = (await status())[0];
  check('one that checked out is offline at once', r.online === false && r.busy === 0);
}

console.log('\nwithout R2 keys\n');
{
  const bare = makeWorld({ s3: false });
  await seedMedia(bare, 1, 'trip');
  const r = await bare.call('POST', '/admin/inbox/start', {
    body: { albumId: 'trip', files: [{ id: hex(9), name: 'a.jpg', size: 10 }] },
  });
  check('uploads say the Worker is not configured', r.status === 503 && /R2 API keys/.test(r.json.error));
  s3State.bucket = w.bucket;
}

finish();
