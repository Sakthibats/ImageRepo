"""Claims uploads, runs every stage on each, and reports back. With no uploads
waiting, re-runs stages the library is behind on: a new stage, or a new
version of one."""
import hashlib
import logging
import shutil
import tempfile
import threading
import time
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import keys, video
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
# The app shows the service as offline after a minute without one of these.
HEARTBEAT_SECONDS = 20
# A stage with nothing left to re-run (or the day's re-runs used up) is asked
# about again after this long, not on every poll: each ask is a D1 query.
RERUN_IDLE = 600


@dataclass
class Rerun:
    """One stage to run again on media already in the library."""
    stage: Stage
    item: dict[str, Any]           # id, kind, ext, and orientation for a turned photo


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
        self.busy = 0
        # What can run again from the original in R2 (see stages/__init__.py).
        self.reruns = [(kind, s) for kind in cfg.kinds for s in stages.get(kind, []) if s.source != 'upload']
        self.rerun_idle: dict[tuple[str, str], float] = {}

    def heartbeat(self, done: threading.Event) -> None:
        """Checks in until `done`, then checks out, so the app knows at once."""
        while True:
            try:
                self.api.heartbeat(self.cfg.kinds, self.busy)
            except Exception as e:
                log.warning('heartbeat failed: %s', e)
            if done.wait(HEARTBEAT_SECONDS):
                break
        try:
            self.api.heartbeat(self.cfg.kinds, 0, stopping=True)
        except Exception as e:
            log.warning('could not check out: %s', e)

    def process(self, item: dict[str, Any]) -> dict[str, Any]:
        """Every stage for one upload; returns the record for the Worker."""
        stages = self.stages.get(item['kind'])
        if not stages:
            raise PermanentError(f'no pipeline for {item["kind"]} yet')
        tmp = Path(tempfile.mkdtemp(prefix='imagerepo-'))
        try:
            path = tmp / f'upload.{item["ext"]}'
            (tmp / 'work').mkdir()
            try:
                self.r2.download(item['key'], path)
            except FileNotFoundError:
                # R2 expires inbox/ after 7 days, whatever the queue says.
                raise PermanentError('no longer in storage: uploads are kept for 7 days') from None
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

    def rerun(self, task: Rerun) -> dict[str, Any]:
        """One stage again, from the media's original in R2; returns its report."""
        item, stage = task.item, task.stage
        tmp = Path(tempfile.mkdtemp(prefix='imagerepo-'))
        try:
            path = tmp / f'original.{item["ext"]}'
            (tmp / 'work').mkdir()
            try:
                self.r2.download(keys.original(item['id'], item['ext']), path)
            except FileNotFoundError:
                raise PermanentError('its original is not in storage') from None

            rewrote = False
            def served(key: str) -> None:
                nonlocal rewrote
                rewrote = rewrote or key.startswith(keys.SERVED)
            def put(key: str, body: bytes, content_type: str) -> None:
                served(key)
                self.r2.put(key, body, content_type)
            def put_file(key: str, src: Path, content_type: str) -> None:
                served(key)
                self.r2.put_file(key, src, content_type)

            job = Job(
                id=item['id'], kind=item['kind'], ext=item['ext'], orig_name='', last_modified=None,
                path=path, work=tmp / 'work', put=put, put_file=put_file, photo_tz=self.cfg.photo_tz,
                orientation=item.get('orientation'),
            )
            # What video stages read from `probe`: the streams, which the MP4
            # original keeps. Only its tags were dropped.
            data: dict[str, Any] = {}
            if item['kind'] == 'video':
                try:
                    data['probe'] = video.probe(path)
                except video.FfmpegError as e:
                    raise PermanentError(f'its original is not a readable video ({e})') from e
            out = stage.run(job, data)
            fields = {k: out[k] for k in ('width', 'height', 'thumbhash') if k in out}
            return {
                'mediaId': item['id'], 'stage': stage.name, 'version': stage.version, 'state': 'done',
                **({'fields': fields} if fields else {}), **({'rewrote': True} if rewrote else {}),
            }
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def claim_reruns(self, room: int) -> list[Rerun]:
        """Media a stage has yet to run on, for one stage at a time."""
        now = time.monotonic()
        for kind, stage in self.reruns:
            if self.rerun_idle.get((kind, stage.name), 0) > now:
                continue
            lease = VIDEO_LEASE if kind == 'video' else PHOTO_LEASE
            items = self.api.stage_claim(stage.name, stage.version, kind, room, lease)['items']
            if items:
                return [Rerun(stage, it) for it in items]
            self.rerun_idle[(kind, stage.name)] = now + RERUN_IDLE
        return []

    def run(self, stop: threading.Event, once: bool = False) -> int:
        """Works until `stop` is set or, with `once`, until the queue is empty.
        Returns how many files were processed."""
        done = threading.Event()
        beat = threading.Thread(target=self.heartbeat, args=(done,), name='heartbeat', daemon=True)
        beat.start()
        try:
            return self.work(stop, once)
        finally:
            done.set()
            beat.join(timeout=10)

    def work(self, stop: threading.Event, once: bool) -> int:
        # A couple more claimed than running, so a thread that frees up starts
        # on the next download at once.
        target = self.cfg.concurrency + 2
        # ffmpeg uses several cores for one video, so few run at once, and
        # photos keep moving alongside them.
        video_slots = max(1, self.cfg.concurrency // 4)
        inflight: dict[Future, dict | Rerun] = {}
        records: list[dict] = []
        failures: list[dict] = []
        reports: list[dict] = []
        last_flush = time.monotonic()
        next_claim = 0.0
        processed = 0

        with ThreadPoolExecutor(self.cfg.concurrency, thread_name_prefix='stage') as pool:
            while True:
                if not stop.is_set() and len(inflight) < target and time.monotonic() >= next_claim:
                    # Videos first, up to their few slots, so a long run of
                    # photos never leaves them waiting until it ends.
                    items = []
                    videos = sum(1 for it in inflight.values() if kind_of(it) == 'video')
                    if 'video' in self.cfg.kinds and videos < video_slots:
                        items += self.api.claim(video_slots - videos, ('video',), VIDEO_LEASE)
                    room = target - len(inflight) - len(items)
                    if 'photo' in self.cfg.kinds and room > 0:
                        items += self.api.claim(room, ('photo',), PHOTO_LEASE)
                    for item in items:
                        log.info('claimed %s (%s, %s)', item['origName'], item['kind'], human(item['bytes']))
                        inflight[pool.submit(self.process, item)] = item
                    if not items:
                        # No uploads waiting: catch up on stages the library is
                        # behind on. Uploads are asked for again first next time.
                        reruns = self.claim_reruns(target - len(inflight)) if self.reruns else []
                        for task in reruns:
                            inflight[pool.submit(self.rerun, task)] = task
                        if reruns:
                            log.info('re-running %s on %d %s(s)', reruns[0].stage.name, len(reruns), reruns[0].item['kind'])
                        else:
                            # Nothing to do; do not ask again for a while.
                            next_claim = time.monotonic() + self.cfg.poll_seconds

                self.busy = len(inflight)
                if not inflight:
                    self.flush(records, failures, reports)
                    if stop.is_set() or once:
                        return processed
                    stop.wait(max(0.0, next_claim - time.monotonic()))
                    continue

                finished, _ = wait(inflight, timeout=1.0, return_when=FIRST_COMPLETED)
                for f in finished:
                    item = inflight.pop(f)
                    if isinstance(item, Rerun):
                        reports.append(rerun_report(item, f))
                        continue
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
                done = len(records) + len(reports)
                if done >= RECORDS_PER_CALL or (done and (due or not inflight)) or failures:
                    self.flush(records, failures, reports)
                    last_flush = time.monotonic()

    def flush(self, records: list[dict], failures: list[dict], reports: list[dict]) -> None:
        """Sends finished records (which makes them visible), failures and re-runs."""
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
        while reports:
            batch = reports[:RECORDS_PER_CALL]
            self.api.stage_report(batch)
            log.info('re-ran %d', len(batch))
            del reports[:len(batch)]


def kind_of(item: dict | Rerun) -> str:
    return item.item['kind'] if isinstance(item, Rerun) else item['kind']


def rerun_report(task: Rerun, f: Future) -> dict[str, Any]:
    """What became of a re-run, for the Worker."""
    head = {'mediaId': task.item['id'], 'stage': task.stage.name, 'version': task.stage.version}
    try:
        report = f.result()
        log.info('re-ran %s on %s', task.stage.name, task.item['id'])
        return report
    except PermanentError as e:
        log.warning('gave up re-running %s on %s: %s', task.stage.name, task.item['id'], e)
        return {**head, 'state': 'failed', 'error': str(e)[:500], 'permanent': True}
    except Exception as e:
        log.exception('re-running %s on %s failed', task.stage.name, task.item['id'])
        return {**head, 'state': 'failed', 'error': f'{type(e).__name__}: {e}'[:500]}


def human(n: int) -> str:
    for unit in ('B', 'KB', 'MB', 'GB'):
        if n < 1024 or unit == 'GB':
            return f'{n:.0f}{unit}' if unit == 'B' else f'{n:.1f}{unit}'
        n /= 1024
    return str(n)
