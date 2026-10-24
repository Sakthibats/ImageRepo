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
         → /admin/inbox/complete (Worker writes D1, bakes album, deletes inbox copy)
         /admin/inbox/heartbeat every 20s → `runners`; the uploader shows online/offline
```

`uploads` (migration 007) holds files until processed; nothing reaches `media`
or a manifest before then. Routes: `packages/worker/src/inbox.ts`.
Browser side: `packages/web/src/upload.ts`.

## Layout

```
packages/shared/   MediaRecord, r2Key, MEDIA_EXT: the contract every part uses
packages/worker/   Hono Worker: /admin (owner + service), /a (owner reads), /s (guests)
  src/inbox.ts     browser uploads and the service's queue
  src/s3.ts        presigned URLs and multipart, via R2's S3 API (aws4fetch)
  test/            Node: Hono app, D1 as SQLite, R2 as a Map, a fake S3 endpoint
packages/web/      React + Vite, built to dist/, served by the Worker
Preprocessing/     Python service: claims uploads, runs the stages (photo, video)
migrations/        every D1 change since schema.sql, numbered, additive
scripts/deploy.mts `npm run deploy`: checks, migrations, build, deploy, smoke test
```

## Commands

```bash
npm test                         # everything: typechecks, Worker tests, pytest (~40s)
npm run -w @imagerepo/worker test   # just the Worker (seconds)
npm run test:python              # just Preprocessing (needs its .venv and ffmpeg)
npm run deploy -- --dry-run      # what would change; changes nothing
npm run deploy                   # migrations, web build, Worker deploy, smoke test
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
- **The web app reads baked JSON**, not D1. Any write that changes an album must
  `bakeAlbum` it.
- **Auth.** `/admin` takes a verified Access JWT or the `ADMIN_TOKEN` bearer;
  JWTs are verified, never trusted by header. The service's Access service
  token (`PREPROCESS_CLIENT_ID`) is held to `SERVICE_PATHS` in `auth.ts`.
  Purge needs a person signed in (`accessUserEmail`). Never echo raw errors.
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
- D1 allows 100 bound parameters; lists of ids go in `IN (...)` chunks of 90.
  Inbox calls are capped (25 files, 20 records) to stay inside Worker limits.
- R2 CORS (`packages/worker/r2-cors.json`) allows PUT from the app's origin
  only; a new hostname needs adding there and re-applying.
- vips headers report stored dimensions; EXIF orientations 5–8 mean displayed
  width and height are swapped.
- The laptop CLI (`packages/ingest`) was removed on 25 Oct 2026; git history has
  it. Its outputs are the reference for the service's parity tests.

## Current state (25 October 2026)

- Branch `cli-stages`, 2 commits ahead of `origin/cli-stages` (docs only),
  not merged to `main`. Production runs `c002223`; migrations 001–009
  applied. R2 CORS and the `inbox/` lifecycle rule are set.
- The CLI is gone, and so are its routes and D1 tables (`ingest_log`,
  `settings`). Every remaining table is in use.
- The library was purged and is being re-added through the browser (4 items
  at last count). The service runs on the laptop (`python -m preprocessing
  run`); not hosted yet.
- Verified end to end: photos from laptop and iPhone; the service's online and
  offline status in the uploader. Not yet: real iPhone video (HEVC/HDR,
  whether the picker converts it), the Docker image (never built), hosting.

## Planned next

0. Merge `cli-stages` into `main` and push; production runs this branch.
1. A backlog mode in the service: claim `/admin/stages/claim` work so a stage
   version bump or a new stage re-processes existing media from `orig/`.
   Stripped JPEGs in `orig/` have lost their EXIF orientation: take it from
   `raw_meta.Orientation`, or rotated photos come out sideways.
2. Host the service (Docker image exists; any always-on box or Cloudflare Containers).
3. Faces (detect + embed from the 1024px copy, local model, owner-only), then objects.
