# Preprocessing

The service that turns browser uploads into library media. The browser puts
each file, as picked, in R2 under `inbox/`. This service claims it from the
Worker, checks its bytes against its id, and runs the stages:

| Kind  | Stages                                        | Writes to R2                     |
|-------|-----------------------------------------------|----------------------------------|
| photo | `exif` → `original` → `derivatives`           | `orig/{id}.{ext}`, `drv/{id}/{320,1024,2048}.avif` |
| video | (coming next) `probe` → `original` → `poster` → `preview` | `orig/`, `post/`, `prev/` |

Then it sends the record to the Worker, which files it in the album (and
folder) it was dropped into, re-bakes the album and deletes the inbox copy.
Records go in batches of up to 20, at least every 5 seconds, so photos appear
while a large upload is still being worked through.

Location stays out of R2: `exif` reads GPS for D1 before anything else, the
original is stripped losslessly (`strip/`), and derivatives are written with
no metadata at all.

## Run it

```bash
cp env.example .env             # fill in the two secrets
python3.12 -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/python -m preprocessing doctor    # checks settings, Worker, R2
.venv/bin/python -m preprocessing run       # Ctrl-C finishes the files in hand
```

Or in Docker: `docker compose up --build -d`, and `docker compose logs -f`.

`once` instead of `run` works until the queue is empty and exits.

## Tests

```bash
.venv/bin/pytest
```

The strippers and the ThumbHash encoder are ports from TypeScript; the tests
run the originals (through the repo's `node_modules`) and require identical
output.

## Adding a stage

Write a class with `name`, `version` and `run(job, data)` in `stages/`, and add
it to `STAGES` in `stages/__init__.py`. `run` uploads its own output with
`job.put` and returns small JSON. Bumping a version means "redo this".
Anything holding location or faces stays owner-only, like GPS.
