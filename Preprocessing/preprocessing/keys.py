"""R2 key layout, as packages/shared/src/index.ts defines it. Content-addressed,
so every key is immutable and cached forever."""

CACHE_FOREVER = 'public, max-age=31536000, immutable'

# What browsers fetch and cache forever. A re-run that writes under one bumps
# the media's revision in D1, which goes in its URLs, so the new file is seen.
SERVED = ('orig/', 'drv/', 'post/', 'prev/')


def original(id: str, ext: str) -> str:
    return f'orig/{id}.{ext}'


def derivative(id: str, width: int) -> str:
    return f'drv/{id}/{width}.avif'


def poster(id: str) -> str:
    return f'post/{id}.jpg'


def video_preview(id: str) -> str:
    return f'prev/{id}.mp4'


CONTENT_TYPES = {
    'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png',
    'heic': 'image/heic', 'heif': 'image/heif',
    'mp4': 'video/mp4', 'mov': 'video/quicktime', 'm4v': 'video/x-m4v',
    'avif': 'image/avif',
}


def content_type(ext: str) -> str:
    return CONTENT_TYPES.get(ext.lower().lstrip('.'), 'application/octet-stream')
