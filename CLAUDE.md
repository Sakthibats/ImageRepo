# CLAUDE.md

Private photo and video library on Cloudflare. R2 holds the bytes, D1 the
metadata, and one Worker serves the API and the React app. The owner's view
is behind Cloudflare Access; guests see one album, or chosen folders of it,
through a revocable share link.

Photos and videos are added in the browser (a file picker, same on phone and
laptop). The browser sends files as picked straight to R2; a Python service
(`Preprocessing/`) strips, resizes and records them.

`Preprocessing/CLAUDE.md` loads when you work there. The README is for people
setting it up.

## How an upload flows

```
browser  hash → POST /admin/inbox/start → PUT inbox/{id}.{ext} (presigned, parts >64MB) → /finish
service  /admin/inbox/claim → download, re-hash → stages → R2 orig/ drv/ post/ prev/
         → /admin/inbox/complete (Worker writes D1, deletes inbox copy)
         /admin/inbox/heartbeat every 20s → `runners`
web      /admin/inbox/summary → album backlog line (service online/offline, waiting,
         processing, failed) and per-album counts; /admin/inbox/retry requeues failed
         uploads still in inbox/ (owner only)
```

`uploads` (migration 007) holds files until processed; nothing reaches `media`
or a manifest before then. Routes: `packages/worker/src/inbox.ts`.
Browser side: `packages/web/src/upload.ts` (sending only) and
`components/Backlog.tsx` (one poller for the album view and album list).

## Layout

```
packages/shared/   MediaRecord, r2Key, MEDIA_EXT: the contract every part uses
packages/worker/   Hono Worker: /admin (owner + service), /a (owner reads), /s (guests)
  src/listing.ts   listMedia(scope, shape): every way of browsing, a page at a time
  src/inbox.ts     browser uploads and the service's queue
  src/s3.ts        presigned URLs and multipart, via R2's S3 API (aws4fetch)
  test/            Node: Hono app, D1 as SQLite, R2 as a Map, a fake S3 endpoint
packages/web/      React + Vite, built to dist/, served by the Worker
Preprocessing/     Python service: claims uploads, runs the stages (photo, video)
migrations/        every D1 change since schema.sql, numbered, additive
deploy.sh          `./deploy.sh`: runs scripts/deploy.mts (checks, migrations, build, deploy, smoke test)
```

## Commands

```bash
npm test                         # everything: typechecks, Worker tests, pytest (~40s)
npm run -w @imagerepo/worker test   # just the Worker (seconds)
npm run test:python              # just Preprocessing (needs its .venv and ffmpeg)
./deploy.sh --dry-run            # what would change; changes nothing
./deploy.sh                      # migrations, web build, Worker deploy, smoke test
(cd Preprocessing && .venv/bin/python -m preprocessing doctor)               # service config check
```

## Rules that must hold

- **Location never reaches a served R2 key or a guest.** GPS lives only in D1
  (`lat`, `lon`, `place`, `raw_meta`). Raw uploads sit in `inbox/`, which no
  route serves and which is deleted once processed (R2 lifecycle: 7 days).
  `orig/` is stripped (photos) or remuxed with all tags dropped (video); a
  format with no stripper is refused. Guest manifests come from a shape with
  no location fields. Face embeddings, when they come, follow the same rule.
- **A guest gets only what their link shares.** `IN_SCOPE` in `share.ts` is
  the one definition; manifest and asset requests both use it.
- **Ids are content hashes** (first 32 hex of SHA-256). Keys are immutable and
  cached forever. The service re-hashes every upload; a mismatch is refused.
- **The Worker is the only writer to D1.** The service writes bytes to R2 and
  sends records to the Worker.
- **Every read is a page.** All listings (library, album, folder, share link,
  tags) go through `listMedia(scope, shape)` in `listing.ts`: one index range,
  at most 500 rows. A new way to browse (a person, an object) is a new scope.
  Counts live on rows (`albums.item_count`, `folders.item_count`) and pages
  sort by `album_media.sort_ts`, all kept by triggers (migration 011); a new
  album link copies `media.sort_ts` (`linkToAlbum`). Tests check pages with
  `planOf` (no `TEMP B-TREE`).
- **Auth.** `/admin` takes a verified Access JWT or the `ADMIN_TOKEN` bearer;
  JWTs are verified, never trusted by header. The service's Access service
  token (`PREPROCESS_CLIENT_ID`) is held to `SERVICE_PATHS` in `auth.ts`.
  Purge needs a person signed in (`accessUserEmail`). Never echo raw errors.
- **A photo lives in one album** (unique `album_media.media_id`, migration
  010). An upload of a file in, or on its way to, another album is refused
  with that album's name; moving takes it out of the old one.
- **Folders are D1-only** (`album_media.folder_id`). A browser upload is filed
  in the folder being viewed; re-sent records never move a photo.
- **Purge empties everything.** New tables go in `TABLES`, new R2 prefixes in
  `PREFIXES` (`purge.ts`); `purge.test.ts` fails otherwise.

## Conventions

- TypeScript in packages/, Python 3.12 in Preprocessing/. Comments say why.
- Worker tests are `tsx` scripts with `check()`; Python uses pytest.
- Migrations: new numbered file; `schema.sql` is not updated. Additive, except
  dropping a table once no deployed code uses it (009 did this).
- Stage names and versions are shared by the service and D1's `media_stages`.
  Bumping a version means "redo this".
- `.env*` files are secrets and blocked from reading and writing; templates
  are named `env.example`. Use `doctor` commands to check configuration.
- Commit in steps; never push or deploy unless asked.

## Gotchas

- Access fronts the workers.dev hostname too, so the service reaches the
  Worker with `CF-Access-Client-Id/Secret` headers and no bearer.
- Free plan, staying there: 10 ms CPU a request, 5M D1 rows read and 100k
  written a day. A `COUNT` reads every row it counts; a sort without an index
  reads the whole table. The web keeps opened albums for the session and does
  not re-read one on every processed photo.
- D1 allows 100 bound parameters; lists of ids go in `IN (...)` chunks of 90.
  Inbox calls are capped (25 files, 20 records) to stay inside Worker limits.
- R2 CORS (`packages/worker/r2-cors.json`) allows PUT from the app's origin
  only; a new hostname needs adding there and re-applying.
- vips headers report stored dimensions; EXIF orientations 5–8 mean displayed
  width and height are swapped.
- The laptop CLI (`packages/ingest`) was removed on 25 Oct 2026; git history has
  it. Its outputs are the reference for the service's parity tests.

## Current state (25 October 2026)

- Work happens on `main`. `cli-stages` is merged into it and can be deleted.
  `main` is unpushed: `origin/main` is still PR #1's merge (`2eb7376`).
  Production runs `e02131a` (one album per photo, the album backlog line,
  per-album counts, Retry without re-upload), checked in a browser; migrations
  001–010 applied. Not yet deployed: the 7-day inbox fixes (a gone upload fails
  at once, `/start` re-sends it, retries back off 1m/5m/30m/2h in
  `lease_until`), and live reads (migration 011, `listMedia`, no more baking).
  R2 CORS and the `inbox/` lifecycle rule are set.
- The CLI is gone, and so are its routes and D1 tables (`ingest_log`,
  `settings`). Every remaining table is in use.
- The library was purged and is being re-added through the browser. The
  service runs on the laptop (`python -m preprocessing run`); not hosted yet.
- Verified end to end: photos from laptop and iPhone; the service's online and
  offline status (in the uploader, before it moved to the backlog line). Not
  yet: real iPhone video (HEVC/HDR, whether the picker converts it), the
  Docker image (never built), hosting.
- The owner plans to add 100k+ photos from laptop and disk, through the
  browser only (no Google Photos import), into albums with one level of
  folders (e.g. Wedding → ROM, Religious, Group shots).

## Planned next

0. Push `main`; deploy (stop the service first). Then, once the app checks
   out: delete the `man/` objects in R2, take `man/` out of `PREFIXES`, and a
   migration 012 drops `albums.manifest_ver` and `album_media.position`.
1. Before the bulk upload, measure ~1,000 files: D1 rows read and written per
   photo, CPU per request. That sets the daily pace on the free plan. Only if
   the numbers say so: load album pages on scroll (web only, same API),
   version-keyed browser caching, exact upload counts by trigger.
2. A backlog mode in the service: claim `/admin/stages/claim` work so a stage
   version bump or a new stage re-processes existing media from `orig/`.
   Stripped JPEGs in `orig/` have lost their EXIF orientation: take it from
   `raw_meta.Orientation`, or rotated photos come out sideways.
3. Host the service (Docker image exists; any always-on box or Cloudflare Containers).
4. Faces (detect + embed from the 1024px copy, local model, owner-only), then
   objects. Agreed shape, not built: everything is a tag. `tags.kind` (yours,
   person, object), `media_tags.source` (owner or model@version) and `score`;
   a `faces` table holds boxes linked to a person tag; embeddings go to R2
   under an owner-only `emb/` (too big for D1), clustered by the service. Each
   is a `listMedia` scope; paging a big tag may need `sort_ts` on `media_tags`.
