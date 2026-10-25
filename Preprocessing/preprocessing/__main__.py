"""python -m preprocessing [run | once | doctor]

  run     work until stopped (Ctrl-C or SIGTERM finishes what is in hand)
  once    work until the queue is empty, then exit
  doctor  check settings, the Worker, R2 and image support
"""
import argparse
import logging
import signal
import sys
import threading


def main() -> int:
    parser = argparse.ArgumentParser(prog='preprocessing', description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('command', nargs='?', default='run', choices=['run', 'once', 'doctor'])
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s',
                        datefmt='%H:%M:%S')
    logging.getLogger('botocore').setLevel(logging.WARNING)
    logging.getLogger('httpx').setLevel(logging.WARNING)

    from .config import ConfigError, load
    try:
        cfg = load()
    except ConfigError as e:
        print(e, file=sys.stderr)
        return 2

    from .api import WorkerApi
    from .r2 import R2
    api, r2 = WorkerApi(cfg), R2(cfg)
    if args.command == 'doctor':
        return doctor(cfg, api, r2)

    from .runner import Runner
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: (logging.info('stopping after the files in hand'), stop.set()))
    logging.info('runner %s, %d at a time, taking %s', cfg.runner, cfg.concurrency, '+'.join(cfg.kinds))
    n = Runner(cfg, api, r2).run(stop, once=args.command == 'once')
    logging.info('processed %d file(s)', n)
    return 0


def doctor(cfg, api, r2) -> int:
    import pyvips
    import pillow_heif

    ok = True

    def line(label: str, good: bool, detail: str) -> None:
        nonlocal ok
        ok &= good
        print(f'  {"ok  " if good else "FAIL"}  {label:<10} {detail}')

    print()
    line('settings', True, f'{cfg.worker_url}, runner {cfg.runner}, {cfg.concurrency} at a time, '
                           f'{"+".join(cfg.kinds)}, dates in {cfg.photo_tz}')
    try:
        h = api.health()
        s = api.summary()
        line('worker', True, f'{h["media"]} items in the library; uploads {s["counts"] or "none waiting"}')
        line('re-runs', True, rerun_status(cfg, api.stage_sweeps()))
    except Exception as e:
        line('worker', False, str(e))
    status = r2.check()
    line('r2', status.startswith('ok'), status)
    from . import video
    if 'video' in cfg.kinds:
        line('video', video.available(), ('ffmpeg found' + (', with VideoToolbox' if video.has_videotoolbox() else ''))
             if video.available() else 'ffmpeg and ffprobe are needed for KINDS=video')
    heif = pillow_heif.libheif_info()
    line('images', bool(heif['decoders']), f'libvips {pyvips.version(0)}.{pyvips.version(1)}, '
                                           f'HEIC via {", ".join(heif["decoders"]) or "nothing"}')
    print()
    return 0 if ok else 1


def rerun_status(cfg, sweeps: dict) -> str:
    """Each stage that can run again from R2, at this service's version: whether
    the library has caught up with it."""
    from .stages import STAGES
    passes = {(w['stage'], w['version'], w['kind']): w for w in sweeps['sweeps']}
    parts = []
    for kind in cfg.kinds:
        for stage in STAGES.get(kind, []):
            if stage.source == 'upload':
                continue
            w = passes.get((stage.name, stage.version, kind))
            state = 'not started' if not w else 'up to date' if w['finishedAt'] else 'catching up'
            failed = f', {w["failed"]} failed' if w and w['failed'] else ''
            parts.append(f'{kind} {stage.name} v{stage.version} {state}{failed}')
    return f'{"; ".join(parts)} ({sweeps["today"]} of {sweeps["perDay"]} today)'


if __name__ == '__main__':
    sys.exit(main())
