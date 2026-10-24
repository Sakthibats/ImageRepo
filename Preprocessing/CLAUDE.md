# Preprocessing (Python service)

Claims browser uploads from the Worker, runs the stages, writes outputs to R2,
reports records. Entry: `python -m preprocessing [run|once|doctor]`.

```
runner.py        claim loop, thread pool, batching of /complete (≤20, ≤5s) and /fail
stages/          registry (__init__.py) + photo.py, video.py; a stage = name, version, run(job, data)
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
docker compose up --build -d # never built yet
```

## Things to know

- Settings come from `.env` (gitignored, unreadable to Claude); template is
  `env.example`. `KINDS` picks photo/video, `PHOTO_TZ` is for EXIF times with
  no offset (the owner is in Asia/Singapore), `CONCURRENCY` defaults to cores.
- libvips (`pyvips[binary]`) and libheif (`pillow-heif`) are wheels; nothing to
  install but ffmpeg. HEIC is decoded by pillow-heif, not vips (no HEVC there).
- vips runs one thread per image (`concurrency_set(1)`); parallelism is the
  runner's thread pool. AVIF: effort 2, 4:4:4, `keep='none'` (no metadata out).
- Videos: a quarter of the slots, claimed before photos, 4h lease (photos 15m).
  Original always remuxed (`-c copy`, `-map_metadata -1`); HEVC gets a 720p
  H.264 preview (VideoToolbox on a Mac, else libx264). No HDR tone-mapping.
- Errors: `PermanentError` → failed at once (hash mismatch, unreadable, no
  stripper); anything else is retried by the Worker up to 5 times.
- Strippers and thumbhash are checked byte-for-byte against outputs recorded
  from the TS originals (`tests/fixtures/expected.json`). A deliberate change
  to their output means a new stage version, not a new fixture.
- `runner.py` checks in every 20s (`heartbeat`) and checks out on exit; the
  uploader shows the service offline a minute after the last check-in.
