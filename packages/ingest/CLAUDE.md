# packages/ingest: the `imagerepo` CLI

The older way in: scans folders on the laptop and processes there (sharp,
ffmpeg), uploading straight to R2 and recording through `/admin/ingest`. The
browser + `Preprocessing/` path replaced it as the standard; its future is an
open decision. Until then its stages must match the service's (same names,
versions, outputs).

```
src/stages/   photo.ts (exif → original → derivatives), video.ts (probe → original → poster → preview)
src/runner.ts runs missing stages per file, sends records in batches (re-sent in 8s if refused)
src/add.ts    collect paths, preview, confirm, run, bake, summary
src/ledger.ts / state.ts   local SQLite ledger at <repo>/.ingest/state.db
```

- `npm run -w @imagerepo/ingest test` (~2 min); `npx imagerepo <cmd>` inside the repo.
- Config in `.env.ingest` (secrets: do not read); `imagerepo doctor` checks it.
- A file is done when every stage has a result at the current version; the
  record is re-sent when `recordKey` (album + stage versions) changes.
- After a purge the ledger is cleared on the next run, by comparing the
  Worker's `library_epoch` (`/admin/health`) with the one it last saw.
- HEIC decodes via `sips` on macOS, else ffmpeg. AVIF effort 2, by measurement
  (`test/bench-derivatives.ts`).
- Uses Worker routes nothing else does: `/admin/ingest`, `/admin/albums/ensure`,
  `/admin/stages/*`, and `library_epoch` in `/admin/health`.
