// Purge, and media and album delete, against an in-memory Worker.
import { makeWorld, seedMedia, accessJwt, check, finish } from './harness.js';

const person = { jwt: await accessJwt({ email: 'owner@example.com', sub: 'u1' }) };
// A script with every credential short of a person: a service-token JWT and ADMIN_TOKEN.
const script = { jwt: await accessJwt({ common_name: 'abc.access', sub: '' }), token: true };
const PHRASE = 'purge everything';

console.log('\npurge everything\n');
{
  const w = makeWorld();
  await seedMedia(w, 1200, 'trip');
  await seedMedia(w, 30, 'kids', 5000);
  await w.call('POST', '/admin/shares', { body: { albumId: 'trip' } });
  await w.call('POST', '/admin/tags/apply', { body: { mediaIds: ['0'.repeat(32)], add: ['beach'] } });
  // A re-run under way: a pass and its claims.
  await w.call('POST', '/admin/stages/claim', { body: { stage: 'derivatives', version: 9, kind: 'photo', limit: 3 } });
  await w.bucket.put('unrelated/keep-me.txt', 'not ours');
  // A browser upload waiting for the processing service.
  await w.bucket.put(`inbox/${'b'.repeat(32)}.jpg`, 'raw, with GPS');
  w.sqlite.prepare(`INSERT INTO uploads (id, kind, ext, bytes, orig_name, album_id, state, created_at, updated_at)
    VALUES (?, 'photo', 'jpg', 13, 'x.jpg', 'trip', 'ready', 0, 0)`).run('b'.repeat(32));

  const byToken = await w.call('POST', '/admin/purge/everything', { body: { confirm: PHRASE } });
  check('ADMIN_TOKEN cannot purge', byToken.status === 403, String(byToken.status));
  const byScript = await w.call('POST', '/admin/purge/everything', { auth: script, body: { confirm: PHRASE } });
  check('a service token with ADMIN_TOKEN cannot purge', byScript.status === 403, String(byScript.status));
  const noAuth = await w.call('POST', '/admin/purge/everything', { auth: 'none', body: { confirm: PHRASE } });
  check('no credentials cannot purge', noAuth.status === 401, String(noAuth.status));
  const wrong = await w.call('POST', '/admin/purge/everything', { auth: person, body: { confirm: 'yes' } });
  check('the confirmation phrase is required', wrong.status === 400, String(wrong.status));
  check('nothing was deleted by refused calls',
    (w.sqlite.prepare('SELECT COUNT(*) AS n FROM media').get() as any).n === 1230);

  const summary = await w.call('GET', '/admin/purge/summary', { auth: person });
  check('summary counts the library', summary.json.photos === 1230 && summary.json.albums === 2 &&
    summary.json.shares === 1 && summary.json.tags === 1 && summary.json.canPurge === true, JSON.stringify(summary.json));
  const scriptSummary = await w.call('GET', '/admin/purge/summary', { auth: script });
  check('a script can read the summary but is told it cannot purge', scriptSummary.status === 200 && scriptSummary.json.canPurge === false);

  let calls = 0;
  w.bucket.calls = 0;
  let res = await w.call('POST', '/admin/purge/everything', { auth: person, body: { confirm: PHRASE } });
  calls++;
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
  check('every library object is gone', w.bucket.keys().every((k) => k.startsWith('unrelated/')),
    w.bucket.keys().filter((k) => !k.startsWith('unrelated/')).slice(0, 5).join(', '));
  check('objects outside the library prefixes are kept', w.bucket.objects.has('unrelated/keep-me.txt'));
  check('the count of deleted objects adds up', deleted >= 1230 * 4, String(deleted));

  const tables = (w.sqlite.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'sqlite_sequence'`
  ).all() as { name: string }[]).map((t) => t.name);
  const left = tables.filter((t) => (w.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n > 0);
  check('every table is empty', left.length === 0, left.join(', '));

  const index = await w.call('GET', '/a/albums');
  check('the app loads an empty album list afterwards', index.status === 200 && index.json.albums.length === 0);

  const album = await w.call('POST', '/admin/albums', { body: { title: 'New' } });
  const again = await w.call('POST', '/admin/inbox/start', {
    body: { albumId: album.json.id, files: [{ id: 'f'.repeat(32), name: 'a.jpg', size: 10 }] },
  });
  check('the library takes new uploads after a purge', again.json?.files?.[0]?.status === 'upload', JSON.stringify(again.json));
}

console.log('\ndeleting media and albums\n');
{
  const w = makeWorld();
  const trip = await seedMedia(w, 250, 'trip');
  const kids = await seedMedia(w, 5, 'kids', 1000);
  // One photo moved out of the album that is deleted later.
  await w.call('POST', '/admin/albums/kids/media', { body: { mediaIds: [trip[0]] } });

  const del = await w.call('DELETE', '/admin/media', { body: { mediaIds: trip.slice(100, 220) } });
  check('deleting more than 100 items at once works', del.status === 200 && del.json.deleted === 120,
    `${del.status} ${JSON.stringify(del.json)}`);
  check('their objects are gone', !w.bucket.objects.has(`orig/${trip[150]}.jpg`) && !w.bucket.objects.has(`drv/${trip[150]}/1024.avif`));
  check('other objects are untouched', w.bucket.objects.has(`orig/${trip[99]}.jpg`));

  const purged = await w.call('DELETE', '/admin/albums/trip?media=delete');
  check('album purge reports what it deleted', purged.json.deletedMedia === 129, JSON.stringify(purged.json));
  check('a photo moved to another album survives', w.bucket.objects.has(`orig/${trip[0]}.jpg`) &&
    Boolean(w.sqlite.prepare('SELECT 1 FROM media WHERE id = ?').get(trip[0])));
  check('the rest of the album is gone from R2', !w.bucket.objects.has(`orig/${trip[1]}.jpg`));
  check('the other album is intact', w.bucket.objects.has(`orig/${kids[0]}.jpg`) &&
    (await w.call('GET', '/a/albums/kids')).json.n === 6);
}

finish();
