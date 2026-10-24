"""R2 key layout, as packages/shared/src/index.ts defines it. Content-addressed,
so every key is immutable and cached forever."""

CACHE_FOREVER = 'public, max-age=31536000, immutable'


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
