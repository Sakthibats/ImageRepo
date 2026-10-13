# ImageRepo

A private photo and video library on Cloudflare R2 + D1, with revocable share links.

- **Private by default.** The full library and every write route sits behind Cloudflare Access.
- **Share links** are unguessable, revocable, optionally passcoded and expiring. No login for viewers.
- **Location stays in the database.** GPS is read at ingest and stored in D1. It is
  removed from JPEG and video originals before upload, and never written into
  anything a guest receives. See [How media is treated](#how-media-is-treated) for
  the formats this does not yet cover.

## Layout

```
packages/
  shared/    types + R2 key layout shared by the CLI, Worker and web app
  ingest/    local CLI: scan, derive, strip, upload, manage share links
  worker/    Cloudflare Worker: admin API, asset serving, guest share routes
  web/       React + Vite app, built to dist/ and served by the Worker
schema.sql   D1 schema
migrations/  D1 changes applied after schema.sql
```

One Worker serves both the API and the web app, so the Cloudflare Access cookie
covers both. Its routes:

| Path | Who | What |
|---|---|---|
| `/admin/*` | owner | ingest, uploads, album/media/tag writes, share-link management |
| `/a/*` | owner | manifests, media, timeline, tags, search |
| `/s/:token` | guests | one shared album, no login |
| everything else | owner | the web app |

## Setup

Requires Node 20+, and `ffmpeg`/`ffprobe` on the machine that runs the CLI.

```bash
npm install

# Cloudflare resources — run these from packages/worker, where wrangler.toml lives
cd packages/worker
npx wrangler d1 create imagerepo        # put the id in wrangler.toml
npx wrangler r2 bucket create imagerepo
npx wrangler d1 execute imagerepo --file=../../schema.sql --remote
npx wrangler d1 execute imagerepo --file=../../migrations/001_drv_ext.sql --remote
npx wrangler d1 execute imagerepo --file=../../migrations/002_tags.sql --remote

# Worker secrets
npx wrangler secret put ADMIN_TOKEN     # bearer token the CLI presents
npx wrangler secret put SHARE_HMAC_KEY  # signs guest sessions and asset URLs
cd ../..

# Build the web app, then deploy the Worker that serves it
npm run -w @imagerepo/web build
npm run worker:deploy
```

Then put Cloudflare Access in front of the Worker's hostname:

1. Create an Access application for the hostname with a policy that allows only you.
   Set `ACCESS_TEAM` and `ACCESS_AUD` in `packages/worker/wrangler.toml` from it.
2. Add a second, path-scoped application for `/s` with a **Bypass** policy, so
   share links work without a login.
3. Create a service token (Zero Trust > Access > Service Auth) so the CLI can get
   past Access.

Finally, configure the CLI:

```bash
cp .env.ingest.example .env.ingest      # R2 keys, Worker URL, ADMIN_TOKEN, service token
npm run ingest -- doctor                # check tooling + connectivity
```

## Ingesting a library

Run the CLI from the repo root; it reads `.env.ingest` and keeps its ledger in
`.ingest/state.db`, both relative to the current directory.

```bash
npm run ingest -- scan ~/Photos                         # see what would be ingested
npm run ingest -- process ~/Photos --dry-run --limit 50
npm run ingest -- process ~/Photos                      # the real run
npm run ingest -- status
```

| Command | What it does |
|---|---|
| `scan <root>` | Walk the folder and list albums and sizes. Touches nothing. |
| `process <root>` | Hash, derive, strip metadata, upload to R2, record in D1. |
| `flush` | Send metadata held locally because the Worker was unreachable. |
| `bake [album]` | Regenerate album manifests. |
| `share create\|list\|revoke\|albums` | Manage share links. |
| `status` | Show progress from the local ledger. |
| `doctor` | Check tooling and cloud connectivity. |

Folders become albums: by default the first folder level under the root is the
album, and `--album-depth` changes that. Files loose at the root go to `unsorted`.

Runs are resumable. Each file's progress is committed to the ledger as it
happens, a file's id is the hash of its bytes so duplicates are skipped, and
re-running `process` retries only what is pending or failed.

## The web app

Open the Worker's hostname and sign in through Access.

- **Photos** is a timeline of the whole library by date.
- **Albums** lets you create, rename, delete and share albums, and move or copy
  items between them.
- **Tags** lets you tag selected items and browse or search by tag.
- Inside an album you can drop photos to upload them from the browser.

For local development, `npm run -w @imagerepo/web dev` starts Vite and proxies
`/a` and `/admin` to the deployed Worker. `npm run worker:dev` runs the Worker
locally.

## Share links

Create one from an album's Share button, or from the CLI:

```bash
npm run ingest -- share create goa-2023 --label "sent to mum" --days 30 --passcode hunter2
npm run ingest -- share list
npm run ingest -- share revoke <token-hash-prefix>
```

- The URL is shown once. Only its SHA-256 is stored, so a database dump exposes
  no live link; if you lose it, revoke and create another.
- `--no-download` lets viewers browse without downloading originals.
- A guest can load only media from the album their link grants.
- Revoking blocks the album listing immediately. Asset URLs already handed out
  keep working for up to an hour.

## How media is treated

Ingested with the CLI:

| | stored in R2 | GPS | notes |
|---|---|---|---|
| JPEG original | yes | removed | EXIF, XMP and IPTC segments dropped; pixels bit-identical, ICC profile kept |
| HEIC / PNG original | yes | **kept** | uploaded byte-for-byte; no stripper for these formats yet |
| AVIF derivatives (320/1024/2048) | yes | n/a | re-encoded, never carries metadata |
| Video original (MP4/MOV/M4V) | yes, as MP4 | removed | lossless remux, `-map_metadata -1`, faststart |
| Video poster | yes | n/a | frame grab, then the photo pipeline |
| Video preview (720p) | if needed | n/a | only for non-H.264, or `--preview-all-video` |

Pass `--preserve-original` to upload byte-exact originals instead, keeping GPS
in R2. Only do this if R2 is meant to be your archival copy.

Uploaded from the browser:

| | stored in R2 | GPS | notes |
|---|---|---|---|
| "Original" | yes | removed | re-encoded JPEG, at most 4096px wide; the source file is not kept |
| WebP derivatives (320/1024/2048) | yes | n/a | rendered in canvas |

Browser upload is for photos only, records no EXIF (the date is the file's
modified time), and is not an archival copy. Use the CLI for video, bulk
backfill, and anything you want stored at full quality.

## Tests

```bash
npm run -w @imagerepo/ingest test
```

`test/strip.test.ts` asserts GPS removal is lossless and that ICC profiles survive.
`test/video.test.ts` asserts the remux drops location while frames stay bit-identical.

The Worker and web app have no tests yet; `npm run -w @imagerepo/worker typecheck`
and the web build's `tsc` step are the only checks there.
