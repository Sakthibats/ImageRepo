# ImageRepo

A private photo library on Cloudflare R2 + D1, with revocable share links.

- **Private by default.** The full library and every write route sits behind Cloudflare Access.
- **Share links** are unguessable, revocable, optionally passcoded and expiring. No login for viewers.
- **Location never leaves the database.** GPS is read at ingest, stored in D1, and removed
  from every byte uploaded to R2 — losslessly, without touching a pixel.

## Layout

```
packages/
  shared/    types + R2 key layout shared by CLI and Worker
  ingest/    local CLI: scan, derive, strip, upload
  worker/    edge API: asset serving, share links, admin  (Phase 2)
schema.sql   D1 schema
```

## Quick start

```bash
npm install
cp .env.ingest.example .env.ingest      # fill in after Cloudflare setup

npx imagerepo doctor                    # check tooling + connectivity
npx imagerepo scan  ~/Photos            # see what would be ingested
npx imagerepo process ~/Photos --dry-run --limit 50
npx imagerepo process ~/Photos          # the real run
npx imagerepo status
```

## How media is treated

| | stored in R2 | GPS | notes |
|---|---|---|---|
| JPEG original | yes | removed | APP1 segment dropped; pixels bit-identical |
| AVIF derivatives (320/1024/2048) | yes | n/a | re-encoded, never carries metadata |
| MP4 original | yes | removed | lossless remux, `-map_metadata -1`, faststart |
| Video poster | yes | n/a | frame grab, then the photo pipeline |
| Video preview (720p) | if needed | n/a | only for non-H.264, or `--preview-all-video` |

Pass `--preserve-original` to upload byte-exact originals instead, keeping GPS
in R2. Only do this if R2 is meant to be your archival copy.

## Tests

```bash
npm run -w @imagerepo/ingest test
```

`test/strip.test.ts` asserts GPS removal is lossless and that ICC profiles survive.
`test/video.test.ts` asserts the remux drops location while frames stay bit-identical.
