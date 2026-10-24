# CLAUDE.md

Private photo and video library on Cloudflare. R2 holds the image bytes, D1 holds
metadata, and one Worker serves both the API and the React app. The owner's view
is behind Cloudflare Access; guests see one album, or chosen folders of it,
through a revocable share link.
Photos are added mainly from the laptop with the `imagerepo` CLI.

The README covers setup and usage for people. This file is what to know before
changing code.

## Layout

```
packages/shared/   types + R2 key layout used by every package (MediaRecord, r2Key)
packages/ingest/   the `imagerepo` CLI: scan, strip, resize, upload, record
  src/stages/      the processing pipeline, one file per kind (photo.ts, video.ts)
  src/runner.ts    runs missing stages per file, sends records in batches
  src/add.ts       the `add` flow: collect paths, preview, confirm, run, bake, summary
  src/ledger.ts    file state derived from stage results; converts old ledgers
  src/state.ts     the local SQLite ledger (.ingest/state.db at the repo root)
  src/{jpeg,png,heic}.ts  lossless metadata strippers
packages/worker/   Hono Worker: /admin (owner writes), /a (owner reads), /s (guests)
  src/purge.ts     purge everything (needs a person signed in through Access)
  test/            Worker tests: the Hono app in Node, D1 as SQLite, R2 as a Map
packages/web/      React + Vite app, built to dist/ and served by the Worker
schema.sql         base D1 schema; migrations/ holds every change since
scripts/deploy.mts `npm run deploy`: checks, migrations, build, deploy, smoke test
```

## Commands

```bash
npm install                                   # also relinks the imagerepo bin
npm run -w @imagerepo/ingest test             # all CLI tests (~2 min)
npm run -w @imagerepo/worker test             # Worker tests (seconds)
npm run -w @imagerepo/worker typecheck
(cd packages/ingest && npx tsc --noEmit)
(cd packages/web && npx tsc --noEmit)

npm run deploy                                # migrations first, then build + deploy
npm run deploy -- --dry-run                   # what would change; changes nothing
npm run migrate:local                         # local dev D1 up to date

npx imagerepo <command>                       # inside the repo; plain `imagerepo` once `npm link`ed
npx tsx packages/ingest/test/bench-derivatives.ts <folder>   # time the resize step on real photos
```

`test/e2e-local.ts` runs the CLI against a local Worker and database; setup steps
are at the top of that file. It refuses any non-local URL.

## Rules that must hold

- **Location never reaches R2 or a guest.** GPS lives only in D1 (`lat`, `lon`,
  `place`, `raw_meta`). Originals are stripped before upload; a format with no
  stripper is refused, never passed through. Guest manifests are built from a
  separate shape that has no location fields. New columns holding location or
  camera metadata must stay out of every guest path.
- **A guest gets only what their link shares.** A link's scope is the whole
  album or chosen folders (+ loose photos). `IN_SCOPE` in `share.ts` is the one
  definition; the guest manifest and every guest asset request both use it, and
  names of folders outside the scope are never sent.
- **Ids are content hashes** (first 32 hex chars of SHA-256). R2 keys are
  immutable and cached forever. Never overwrite an object under an existing key
  with different bytes.
- **The Worker is the only writer to D1.** The CLI writes bytes straight to R2 but
  sends metadata through `/admin/ingest`.
- **The web app reads baked JSON, not D1.** Album and index manifests are written
  to R2 by `bakeAlbum`/`bakeIndex`. Any write that changes an album must re-bake
  it, or the change is invisible.
- **Auth:** `/admin` accepts a verified Access JWT or the `ADMIN_TOKEN` bearer.
  The workers.dev hostname is reachable without Access, so JWTs are verified,
  never trusted by header presence. Never echo raw errors to clients. Purging
  needs more: `accessUserEmail`, a JWT with an email and no `common_name`, so
  neither `ADMIN_TOKEN` nor the CLI's service token can wipe the library.
- **Folders are D1-only.** A folder is `album_media.folder_id`; filing photos
  never touches R2. The CLI never sets a folder, and re-sent records keep the
  one set in the web app (`ON CONFLICT DO NOTHING`).
- **Purge empties every table.** A new table must be added to `TABLES` in
  `purge.ts`; `purge.test.ts` fails if any table still has rows afterwards.

## The stage pipeline

Photos run `exif → original → derivatives`; videos run
`probe → original → poster → preview` (`packages/ingest/src/stages/index.ts`).

- Each stage has a `name` and `version`, uploads its own output, and returns
  small JSON. Results are stored in the ledger per content hash, so a duplicate
  file is processed once.
- A file is done when every stage has a result at the current version. There is
  no status flag to trust; `files.status` is a human-readable cache only.
- To add processing: write a stage and add it to `STAGES`. To redo a step for the
  whole library: bump its version. Either turns existing items into a backlog
  that the next `add`/`retry` works through.
- The record sent to D1 is rebuilt from stage data (`buildRecord`). `recordKey`
  (album + stage versions) decides whether a record needs re-sending.
- Before re-processing anything uploaded earlier, the runner checks the original
  still exists in R2. If not, the item was deleted in the web app and is left
  alone unless `--restore` is passed.
- D1 mirrors stage progress in `media_stages`. `/admin/stages/{pending,claim,report,failed,summary}`
  let other runners take work under a lease; five failures park an item until
  the version changes.

## Conventions

- TypeScript throughout. The CLI runs from source via tsx (`bin/imagerepo.js`);
  there is no build step.
- Comments explain why, not what. Match the existing density.
- Migrations are new numbered files in `migrations/`, additive only. `schema.sql`
  is not updated with them. Wrangler records applied ones in `d1_migrations`;
  `npm run deploy` applies new ones before deploying the Worker.
- Tests are plain `tsx` scripts with a `check()` helper, not a framework.
- The user's `.env.ingest` holds secrets; do not read it. Use `imagerepo doctor`
  to check configuration.

## Gotchas

- `npx imagerepo` only resolves inside this repo. Outside it, npm looks for a
  public package. `npm link` in `packages/ingest` gives a global `imagerepo`, tied
  to the active Node version.
- The CLI finds `.env.ingest` and the ledger from the repo root, not the working
  directory. User-typed paths resolve against `INIT_CWD`.
- sharp's prebuilt binaries cannot decode HEIC. `decode.ts` converts with `sips`
  on macOS, else ffmpeg. HEIC on Linux is untested.
- `sharp().metadata()` reports stored dimensions; EXIF orientations 5–8 mean the
  displayed image is the other way round.
- AVIF effort dominates ingest time. Effort 2 was chosen by measurement; check
  `bench-derivatives.ts` before raising it.
- Each record is several D1 statements and Workers cap statements per request.
  The runner re-sends a refused batch in pieces of 8. In the Worker, lists of ids
  go into `IN (...)` chunks of 90 (D1 allows 100 bound parameters), not one
  statement per id.
- After a purge the CLI clears its ledger on the next `add`/`retry`/`flush`: it
  compares the Worker's `library_epoch` (in `/admin/health`) with the one the
  ledger last saw.
- Node 20 prints an AWS SDK deprecation warning; the SDK will need Node 22 from
  2027.

## Current state (24 October 2026)

- **Branch.** All recent work is on `cli-stages`, which is neither merged into
  `main` nor pushed. Production runs code from this branch (last Worker deploy
  13 October). Purge, folders, share scope and `npm run deploy` are committed
  but not deployed.
- **Live library.** 647 items (1 video) in 2 albums, 4 share links, no tags.
  Migrations 001–003 were applied by hand; 004–006 are not applied. The first
  `npm run deploy` records 001–003 in `d1_migrations` (after asking).
- **Plan.** The owner will purge everything and re-upload, so the pending
  `derivatives` v2 `retry` is moot: the re-upload runs at the current version.
- **Known leftovers.** Three Helipad items were deleted in the web app and will
  keep showing as pending in `imagerepo status`. A stray test ledger at
  `packages/ingest/.ingest/` is unused and can be deleted.
- **Unverified.** Real iPhone HEIC files (tiled, rotated) have only been tested
  with `sips`-made fixtures.

## Planned next

Upload improvements, roughly in priority order:

1. Record and bake periodically during a run, so photos appear before it ends.
2. Ask the server which hashes it already has before resizing anything.
3. Separate the upload queue from the CPU queue.
4. A watch folder (macOS LaunchAgent) that runs `add` unattended.
5. Resumable multipart uploads for large videos.
6. Direct-to-R2 uploads from a phone or browser (presigned URLs).

Face clustering is designed but deferred until uploads are done: a `faces` stage
(detect and embed, from the 1024px copy, with a local model) plus a separate
clustering job; people are stored library-wide and filtered per album. Face
embeddings follow the same rule as location: owner-only.
