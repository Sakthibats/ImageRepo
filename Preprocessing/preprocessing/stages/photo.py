from typing import Any

from .. import keys
from ..exif import read_exif
from ..images import process_photo
from ..strip import StripError, strip_metadata
from . import Job, PermanentError


class Exif:
    """Captures metadata BEFORE anything is stripped: this is what reaches D1."""
    name = 'exif'
    # v2: also keeps every tag the camera wrote (`raw`).
    version = 2

    def run(self, job: Job, data: dict[str, Any]) -> dict[str, Any]:
        fields, raw = read_exif(job.path, job.photo_tz)
        return {**fields, 'raw': raw}


class Original:
    """The original, with its metadata gone and every pixel kept."""
    name = 'original'
    version = 1

    def run(self, job: Job, data: dict[str, Any]) -> dict[str, Any]:
        try:
            result = strip_metadata(job.path.read_bytes(), job.ext)
        except StripError as e:
            raise PermanentError(str(e)) from e
        job.put(keys.original(job.id, job.ext), result.data, keys.content_type(job.ext))
        return {'ext': job.ext, 'bytes': len(result.data), 'stripped': result.stripped}


class Derivatives:
    """Resized copies. Written with no metadata, so GPS-free by construction."""
    name = 'derivatives'
    # v2: correct width/height for photos the camera marked as rotated.
    version = 2

    def run(self, job: Job, data: dict[str, Any]) -> dict[str, Any]:
        r = process_photo(job.path, job.ext)
        for d in r.derivatives:
            job.put(keys.derivative(job.id, d.width), d.body, 'image/avif')
        return {
            'width': r.width, 'height': r.height, 'thumbhash': r.thumbhash,
            'derivatives': [d.name for d in r.derivatives],
        }
