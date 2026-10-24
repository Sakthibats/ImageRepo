"""The row the Worker stores, rebuilt from what the stages produced.

The shape is MediaRecord in packages/shared/src/index.ts, as the CLI's
buildRecord makes it. Album and folder are not set here: the Worker takes
them from the upload, so the service cannot file anything anywhere.
"""
import time
from typing import Any

from .exif import date_from_filename
from .stages import STAGES, Job


def build_record(job: Job, data: dict[str, Any]) -> dict[str, Any]:
    stages = [{'name': s.name, 'version': s.version} for s in STAGES[job.kind]]
    original = data['original']
    if job.kind != 'photo':
        raise NotImplementedError('video records arrive with the video stages')

    e = {k: v for k, v in data['exif'].items() if k != 'raw'}
    d = data['derivatives']
    record = {
        'id': job.id, 'kind': 'photo', 'ext': original['ext'], 'bytes': original['bytes'],
        'width': d['width'], 'height': d['height'],
        'takenAt': e.get('takenAt') or date_from_filename(job.orig_name) or job.last_modified or int(time.time()),
        'camera': e.get('camera'), 'lens': e.get('lens'), 'iso': e.get('iso'),
        'fstop': e.get('fstop'), 'focalMm': e.get('focalMm'),
        'lat': e.get('lat'), 'lon': e.get('lon'),
        'thumbhash': d['thumbhash'],
        'origName': job.orig_name,
        'albums': [],
        'derivatives': d['derivatives'],
        'rawMeta': data['exif'].get('raw'),
        'stages': stages,
    }
    return {k: v for k, v in record.items() if v is not None}
