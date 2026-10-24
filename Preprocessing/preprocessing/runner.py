"""Claims uploads, runs every stage on each, and reports back."""
import hashlib
import logging
import shutil
import tempfile
import threading
import time
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from pathlib import Path
from typing import Any

from .api import WorkerApi
from .config import Config
from .r2 import R2
from .record import build_record
from .stages import STAGES, Job, PermanentError, Stage

log = logging.getLogger('preprocessing')

# The Worker takes at most 20 records per /complete.
RECORDS_PER_CALL = 20
# A claim is a lease: if this machine dies, the file goes back in the queue
# when it lapses. A long video transcode must finish well inside its lease.
PHOTO_LEASE = 15 * 60
VIDEO_LEASE = 4 * 3600


def content_id(path: Path) -> str:
    """The library's id for a file: the first 32 hex chars of its SHA-256."""
    h = hashlib.sha256()
    with path.open('rb') as f:
        while chunk := f.read(1024 * 1024):
            h.update(chunk)
    return h.hexdigest()[:32]


class Runner:
    def __init__(self, cfg: Config, api: WorkerApi, r2: R2, stages: dict[str, list[Stage]] = STAGES):
        self.cfg, self.api, self.r2, self.stages = cfg, api, r2, stages

    def process(self, item: dict[str, Any]) -> dict[str, Any]:
        """Every stage for one upload; returns the record for the Worker."""
        stages = self.stages.get(item['kind'])
        if not stages:
            raise PermanentError(f'no pipeline for {item["kind"]} yet')
        tmp = Path(tempfile.mkdtemp(prefix='imagerepo-'))
        try:
            path = tmp / f'upload.{item["ext"]}'
            (tmp / 'work').mkdir()
            self.r2.download(item['key'], path)
            # The id came from the browser. Bytes that do not match it must
            # never be written under it: R2 keys are immutable.
            actual = content_id(path)
            if actual != item['id']:
                raise PermanentError(f'the uploaded bytes hash to {actual}, not to their id')

            job = Job(
                id=item['id'], kind=item['kind'], ext=item['ext'], orig_name=item['origName'],
                last_modified=item.get('lastModified'), path=path, work=tmp / 'work',
                put=self.r2.put, put_file=self.r2.put_file, photo_tz=self.cfg.photo_tz,
            )
            data: dict[str, Any] = {}
            for stage in stages:
                data[stage.name] = stage.run(job, data)
            return build_record(job, data)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def run(self, stop: threading.Event, once: bool = False) -> int:
        """Works until `stop` is set or, with `once`, until the queue is empty.
        Returns how many files were processed."""
        # A couple more claimed than running, so a thread that frees up starts
        # on the next download at once.
        target = self.cfg.concurrency + 2
        # ffmpeg uses several cores for one video, so few run at once, and
        # photos keep moving alongside them.
        video_slots = max(1, self.cfg.concurrency // 4)
        inflight: dict[Future, dict] = {}
        records: list[dict] = []
        failures: list[dict] = []
        last_flush = time.monotonic()
        next_claim = 0.0
        processed = 0

        with ThreadPoolExecutor(self.cfg.concurrency, thread_name_prefix='stage') as pool:
            while True:
                if not stop.is_set() and len(inflight) < target and time.monotonic() >= next_claim:
                    # Videos first, up to their few slots, so a long run of
                    # photos never leaves them waiting until it ends.
                    items = []
                    videos = sum(1 for it in inflight.values() if it['kind'] == 'video')
                    if 'video' in self.cfg.kinds and videos < video_slots:
                        items += self.api.claim(video_slots - videos, ('video',), VIDEO_LEASE)
                    room = target - len(inflight) - len(items)
                    if 'photo' in self.cfg.kinds and room > 0:
                        items += self.api.claim(room, ('photo',), PHOTO_LEASE)
                    for item in items:
                        log.info('claimed %s (%s, %s)', item['origName'], item['kind'], human(item['bytes']))
                        inflight[pool.submit(self.process, item)] = item
                    if not items:
                        # The queue is empty; do not ask again for a while.
                        next_claim = time.monotonic() + self.cfg.poll_seconds

                if not inflight:
                    self.flush(records, failures)
                    if stop.is_set() or once:
                        return processed
                    stop.wait(max(0.0, next_claim - time.monotonic()))
                    continue

                finished, _ = wait(inflight, timeout=1.0, return_when=FIRST_COMPLETED)
                for f in finished:
                    item = inflight.pop(f)
                    try:
                        records.append(f.result())
                        processed += 1
                        log.info('processed %s', item['origName'])
                    except PermanentError as e:
                        log.warning('gave up on %s: %s', item['origName'], e)
                        failures.append({'id': item['id'], 'error': str(e)[:500], 'permanent': True})
                    except Exception as e:
                        log.exception('failed %s', item['origName'])
                        failures.append({'id': item['id'], 'error': f'{type(e).__name__}: {e}'[:500]})

                due = time.monotonic() - last_flush >= self.cfg.flush_seconds
                if len(records) >= RECORDS_PER_CALL or (records and (due or not inflight)) or failures:
                    self.flush(records, failures)
                    last_flush = time.monotonic()

    def flush(self, records: list[dict], failures: list[dict]) -> None:
        """Sends finished records (which makes them visible) and failures."""
        while records:
            batch = records[:RECORDS_PER_CALL]
            r = self.api.complete(batch)
            for s in r.get('skipped', []):
                log.warning('the Worker did not record %s: %s', s['id'], s['reason'])
            log.info('recorded %d file(s)', r.get('recorded', 0))
            del records[:len(batch)]
        while failures:
            batch = failures[:50]
            self.api.fail(batch)
            del failures[:len(batch)]


def human(n: int) -> str:
    for unit in ('B', 'KB', 'MB', 'GB'):
        if n < 1024 or unit == 'GB':
            return f'{n:.0f}{unit}' if unit == 'B' else f'{n:.1f}{unit}'
        n /= 1024
    return str(n)
