// Purge, album delete, and manifest cleanup, against an in-memory Worker.
import { makeWorld, seedMedia, accessJwt, check, finish } from './harness.js';

const person = { jwt: await accessJwt({ email: 'owner@example.com', sub: 'u1' }) };
// What the CLI sends: Access adds a service-token JWT, and the CLI its bearer.
const cli = { jwt: await accessJwt({ common_name: 'abc.access', sub: '' }), token: true };
const PHRASE = 'purge everything';

console.log('\npurge everything\n');
{
  const w = makeWorld();
  await seedMedia(w, 1200, 'trip');
  await seedMedia(w, 30, 'kids', 5000);
  await w.call('POST', '/admin/shares', { body: { albumId: 'trip' } });
  await w.call('POST', '/admin/tags/apply', { body: { mediaIds: ['0'.repeat(32)], add: ['beach'] } });
  await w.bucket.put('unrelated/keep-me.txt', 'not ours');
  // A browser upload waiting for the processing service.
  await w.bucket.put(`inbox/${'b'.repeat(32)}.jpg`, 'raw, with GPS');
  w.sqlite.prepare(`INSERT INTO uploads (id, kind, ext, bytes, orig_name, album_id, state, created_at, updated_at)
    VALUES (?, 'photo', 'jpg', 13, 'x.jpg', 'trip', 'ready', 0, 0)`).run('b'.repeat(32));

  const before = (await w.call('GET', '/admin/health')).json.epoch;
  check('a fresh library has an epoch', before === 'initial', String(before));

  const byToken = await w.call('POST', '/admin/purge/everything', { body: { confirm: PHRASE } });
  check('ADMIN_TOKEN cannot purge', byToken.status === 403, String(byToken.status));
  const byCli = await w.call('POST', '/admin/purge/everything', { auth: cli, body: { confirm: PHRASE } });
  check('the CLI, with a service token and ADMIN_TOKEN, cannot purge', byCli.status === 403, String(byCli.status));
  const noAuth = await w.call('POST', '/admin/purge/everything', { auth: 'none', body: { confirm: PHRASE } });
  check('no credentials cannot purge', noAuth.status === 401, String(noAuth.status));
  const wrong = await w.call('POST', '/admin/purge/everything', { auth: person, body: { confirm: 'yes' } });
  check('the confirmation phrase is required', wrong.status === 400, String(wrong.status));
  check('nothing was deleted by refused calls',
    (w.sqlite.prepare('SELECT COUNT(*) AS n FROM media').get() as any).n === 1230);

  const summary = await w.call('GET', '/admin/purge/summary', { auth: person });
  check('summary counts the library', summary.json.photos === 1230 && summary.json.albums === 2 &&
    summary.json.shares === 1 && summary.json.tags === 1 && summary.json.canPurge === true, JSON.stringify(summary.json));
  const cliSummary = await w.call('GET', '/admin/purge/summary', { auth: cli });
  check('the CLI can read the summary but is told it cannot purge', cliSummary.status === 200 && cliSummary.json.canPurge === false);

  let calls = 0;
  w.bucket.calls = 0;
  let res = await w.call('POST', '/admin/purge/everything', { auth: person, body: { confirm: PHRASE } });
  calls++;
  const epoch = res.json.epoch;
  let deleted = res.json.deleted;
  const firstCallR2 = w.bucket.calls;
  while (res.status === 200 && !res.json.done && calls < 50) {
    w.bucket.calls = 0;
    res = await w.call('POST', '/admin/purge/everything', { auth: person, body: { confirm: PHRASE, resume: true } });
    deleted += res.json.deleted;
    calls++;
  }
  check('purge finishes over several calls', res.json.done === true && calls > 1, `${calls} calls`);
  check('each call stays small', firstCallR2 < 30, `${firstCallR2} R2 calls`);
  check('every library object is gone', w.bucket.keys().every((k) => k.startsWith('unrelated/') || k.startsWith('man/index.')),
    w.bucket.keys().filter((k) => !k.startsWith('unrelated/')).slice(0, 5).join(', '));
  check('objects outside the library prefixes are kept', w.bucket.objects.has('unrelated/keep-me.txt'));
  check('the count of deleted objects adds up', deleted >= 1230 * 4, String(deleted));

  const tables = (w.sqlite.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('settings', 'sqlite_sequence')`
  ).all() as { name: string }[]).map((t) => t.name);
  const left = tables.filter((t) => (w.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n > 0);
  check('every table is empty', left.length === 0, left.join(', '));

  const after = (await w.call('GET', '/admin/health')).json.epoch;
  check('the epoch changed', after === epoch && after !== before, `${before} -> ${after}`);

  const index = await w.call('GET', '/a/manifest/index');
  check('the app loads an empty index afterwards', index.status === 200 && index.json.albums.length === 0);

  const again = await w.call('POST', '/admin/ingest', {
    body: { records: [{ id: 'f'.repeat(32), kind: 'photo', ext: 'jpg', bytes: 1, origName: 'a.jpg', albums: ['new'], derivatives: [] }] },
  });
  check('the library takes new uploads after a purge', again.status === 200);
}

console.log('\ndeleting media and albums\n');
{
  const w = makeWorld();
  const trip = await seedMedia(w, 250, 'trip');
  const kids = await seedMedia(w, 5, 'kids', 1000);
  // One photo in both albums.
  await w.call('POST', '/admin/albums/kids/media', { body: { mediaIds: [trip[0]] } });

  const del = await w.call('DELETE', '/admin/media', { body: { mediaIds: trip.slice(100, 220) } });
  check('deleting more than 100 items at once works', del.status === 200 && del.json.deleted === 120,
    `${del.status} ${JSON.stringify(del.json)}`);
  check('their objects are gone', !w.bucket.objects.has(`orig/${trip[150]}.jpg`) && !w.bucket.objects.has(`drv/${trip[150]}/1024.avif`));
  check('other objects are untouched', w.bucket.objects.has(`orig/${trip[99]}.jpg`));

  const purged = await w.call('DELETE', '/admin/albums/trip?media=delete');
  check('album purge reports what it deleted', purged.json.deletedMedia === 129, JSON.stringify(purged.json));
  check('a photo also in another album survives', w.bucket.objects.has(`orig/${trip[0]}.jpg`) &&
    Boolean(w.sqlite.prepare('SELECT 1 FROM media WHERE id = ?').get(trip[0])));
  check('the rest of the album is gone from R2', !w.bucket.objects.has(`orig/${trip[1]}.jpg`));
  check('the deleted album has no manifests left', w.bucket.keys('man/album/trip.').length === 0,
    w.bucket.keys('man/album/trip.').join(', '));
  check('the other album is intact', w.bucket.keys('man/album/kids.').length > 0 &&
    w.bucket.objects.has(`orig/${kids[0]}.jpg`));
}

console.log('\nmanifest cleanup\n');
{
  const w = makeWorld();
  await seedMedia(w, 3, 'trip');
  for (let i = 0; i < 5; i++) await w.call('POST', '/admin/bake', { body: { album: 'trip' } });
  const vers = new Set(w.bucket.keys('man/album/trip.').map((k) => k.split('.')[2]));
  check('only the current and previous versions are kept', vers.size === 2 && w.bucket.keys('man/album/trip.').length === 4,
    w.bucket.keys('man/album/trip.').join(', '));

  await w.bucket.put('man/album/gone.owner.abc.json', '{}');
  await w.bucket.put('man/album/gone.abc.json', '{}');
  await w.call('POST', '/admin/bake', { body: {} });
  check('a full bake sweeps manifests of albums that no longer exist', w.bucket.keys('man/album/gone.').length === 0);
  check('and keeps live ones', w.bucket.keys('man/album/trip.').length === 4);
}

finish();
