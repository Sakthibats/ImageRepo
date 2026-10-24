from typing import Any

from .. import keys, video
from ..images import process_photo
from . import Job, PermanentError


class Probe:
    """Stream and container metadata, GPS included, for D1."""
    name = 'probe'
    # v2: also keeps the container's tags (`raw`).
    version = 2

    def run(self, job: Job, data: dict[str, Any]) -> dict[str, Any]:
        try:
            return video.probe(job.path)
        except video.FfmpegError as e:
            raise PermanentError(f'not a readable video ({e})') from e


class VideoOriginal:
    """The recording, remuxed to MP4 with no metadata. Always remuxed: a
    file can carry the camera's identity even when it has no location."""
    name = 'original'
    version = 1

    def run(self, job: Job, data: dict[str, Any]) -> dict[str, Any]:
        out = job.work / 'original.mp4'
        try:
            video.remux(job.path, out)
        except video.FfmpegError as e:
            raise PermanentError(f'cannot be stored as MP4 without re-encoding ({e})') from e
        job.put_file(keys.original(job.id, 'mp4'), out, 'video/mp4')
        return {'ext': 'mp4', 'bytes': out.stat().st_size, 'stripped': ['container']}


class Poster:
    """A still for the grid, through the photo resizer so it gets the same sizes."""
    name = 'poster'
    version = 1

    def run(self, job: Job, data: dict[str, Any]) -> dict[str, Any]:
        frame = job.work / 'poster.jpg'
        video.poster(job.path, data['probe']['durationMs'], frame)
        job.put(keys.poster(job.id), frame.read_bytes(), 'image/jpeg')
        r = process_photo(frame, 'jpg')
        for d in r.derivatives:
            job.put(keys.derivative(job.id, d.width), d.body, 'image/avif')
        return {'thumbhash': r.thumbhash, 'derivatives': ['poster', *(d.name for d in r.derivatives)]}


class Preview:
    """A browser-playable copy, when the recording's codec will not play everywhere."""
    name = 'preview'
    version = 1

    def run(self, job: Job, data: dict[str, Any]) -> dict[str, Any]:
        if video.web_playable(data['probe']['codec']):
            return {'made': False}
        out = job.work / 'preview.mp4'
        video.preview(job.path, out)
        job.put_file(keys.video_preview(job.id), out, 'video/mp4')
        return {'made': True}
