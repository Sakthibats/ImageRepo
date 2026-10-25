# Preprocessing (Python service)

Claims browser uploads from the Worker, runs the stages, writes outputs to R2,
reports records. With no uploads waiting, re-runs stages the library is
behind on. Entry: `python -m preprocessing [run|once|doctor]`.

```
runner.py        claim loop, thread pool, batching of /complete (≤20, ≤5s) and /fail;
                 re-runs (/admin/stages/claim, /report) when the inbox is empty
stages/          registry (__init__.py) + photo.py, video.py; a stage = name, version,
                 source ('upload' | 'orig'), run(job, data)
strip/           lossless metadata removal: jpeg, png, heic (ported from the removed CLI)
exif.py          photo metadata via Pillow; video.py: ffprobe/ffmpeg
images.py        upright sRGB base ≤2048 wide → 320/1024/2048 AVIF + thumbhash
record.py        MediaRecord for the Worker, from stage outputs
api.py / r2.py   Worker client (Access service token) / boto3 against R2
```

## Commands

```bash
python3.12 -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/pytest -q          # ~15s; needs ffmpeg for the video tests
.venv/bin/python -m preprocessing doctor
docker build --target test . # the test suite inside the image (~2 min)
docker compose run --rm preprocessing doctor
docker compose up --build -d # as a service; give its .env its own RUNNER_NAME
```

## Things to know

- Settings come from `.env` (gitignored, unreadable to Claude); template is
  `env.example`. `KINDS` picks photo/video, `PHOTO_TZ` is for EXIF times with
  no offset (the owner is in Asia/Singapore), `CONCURRENCY` defaults to cores.
- libvips (`pyvips[binary]`) and libheif (`pillow-heif`) are wheels; nothing to
  install but ffmpeg. HEIC is decoded by pillow-heif, not vips (no HEVC there).
- The image is Debian trixie (ffmpeg 7.1): bookworm's 5.1 lacks options the
  video tests use. Built and tested on arm64 and amd64. On 2 vCPUs (M-series,
  in Docker): ~0.55s per 12MP photo two at a time, ~6,500 an hour; an HEVC
  preview takes 0.5–0.9s per second of video (libx264, no VideoToolbox).
- vips runs one thread per image (`concurrency_set(1)`); parallelism is the
  runner's thread pool. AVIF: effort 2, 4:4:4, `keep='none'` (no metadata out).
- Videos: a quarter of the slots, claimed before photos, 4h lease (photos 15m).
  Original always remuxed (`-c copy`, `-map_metadata -1`); HEVC gets a 720p
  H.264 preview (VideoToolbox on a Mac, else libx264). No HDR tone-mapping.
- Errors: `PermanentError` → failed at once (hash mismatch, unreadable, no
  stripper, gone from `inbox/`); anything else is retried by the Worker up to
  5 times, waiting longer before each.
- Strippers and thumbhash are checked byte-for-byte against outputs recorded
  from the TS originals (`tests/fixtures/expected.json`). A deliberate change
  to their output means a new stage version, not a new fixture.
- `runner.py` checks in every 20s (`heartbeat`) and checks out on exit; the
  uploader shows the service offline a minute after the last check-in.
- Re-runs: only `source = 'orig'` stages, from `orig/` in R2. A stripped JPEG
  or PNG has lost its EXIF orientation; the claim carries it (`Job.orientation`)
  and `upright_base` turns the photo itself, sized as an upload would be.
  Videos are probed again from their MP4 (streams and rotation survive the
  remux). A write under `keys.SERVED` reports `rewrote`, which bumps
  `media.rev`. A stage with nothing behind is asked about every 10 minutes
  (`RERUN_IDLE`); the Worker caps re-runs at 5,000 a day.
