"""Resized copies of a photo, as AVIF, plus its ThumbHash.

The same widths, qualities and effort the retired CLI used: upright, never
upscaled. Every output is written with no metadata at all, so
derivatives are GPS-free by construction.
"""
from dataclasses import dataclass
from pathlib import Path

import pyvips
from PIL import Image

from .thumbhash import thumbhash_b64

WIDTHS = (320, 1024, 2048)
# Small images can afford lower quality; the lightbox image is what people
# actually scrutinise, so it gets the most bits.
QUALITY = {320: 55, 1024: 58, 2048: 62}
# AVIF encoder effort, 0-9. Measured in the CLI on 26MP JPEGs: effort 4 was
# ~5s of CPU a photo, effort 2 ~0.9s for files about 3% larger.
EFFORT = 2
# vips' thumbnail fits into a box; a tall box makes width the only limit.
TALL = 10_000_000

# Each photo runs on its own thread (runner.py), so one vips thread each
# keeps the CPU busy without every image fighting for every core.
pyvips.concurrency_set(1)
pyvips.cache_set_max(0)


@dataclass
class Derivative:
    name: str
    width: int
    body: bytes


@dataclass
class PhotoResult:
    width: int          # displayed, i.e. after rotation
    height: int
    thumbhash: str
    derivatives: list[Derivative]


def process_photo(path: Path, ext: str) -> PhotoResult:
    width, height, base = upright_base(path, ext)
    if not width or not height:
        raise ValueError('could not read image dimensions')

    derivatives = []
    for w in WIDTHS:
        # Never upscale: a 900px-wide photo gets no 1024 or 2048 copy.
        if w > width and w != WIDTHS[0]:
            continue
        img = base.thumbnail_image(w, height=TALL, size='down')
        body = img.heifsave_buffer(
            Q=QUALITY[w], effort=EFFORT, compression='av1', bitdepth=8,
            # 4:4:4, as sharp writes AVIF; and no EXIF, XMP or ICC in the output.
            subsample_mode='off', keep='none',
        )
        derivatives.append(Derivative(str(w), w, body))
    return PhotoResult(width, height, thumbhash_of(base), derivatives)


def upright_base(path: Path, ext: str) -> tuple[int, int, pyvips.Image]:
    """Displayed size, and the photo upright in sRGB at no more than the
    largest width kept, decoded once in memory for every size made from it."""
    if ext in ('heic', 'heif'):
        # libvips' HEIF loader cannot decode HEVC here; pillow-heif can, and
        # applies the file's rotation as it does.
        with Image.open(path) as im:
            im = im.convert('RGBA' if 'A' in im.getbands() else 'RGB')
            icc = im.info.get('icc_profile')
            width, height = im.size
            full = pyvips.Image.new_from_memory(im.tobytes(), width, height, len(im.getbands()), 'uchar')
        if icc:
            full = full.copy()
            full.set_type(pyvips.GValue.blob_type, 'icc-profile-data', icc)
            full = full.icc_transform('srgb', embedded=True)
        base = full.thumbnail_image(WIDTHS[-1], height=TALL, size='down')
    else:
        head = pyvips.Image.new_from_file(str(path))
        orientation = head.get('orientation') if head.get_typeof('orientation') else 1
        # The header describes the stored pixels. Orientations 5-8 mean the
        # camera was turned, so the picture as seen is the other way round.
        width, height = (head.height, head.width) if orientation >= 5 else (head.width, head.height)
        # Shrink-on-load, rotated upright, converted to sRGB from any embedded profile.
        base = pyvips.Image.thumbnail(str(path), WIDTHS[-1], height=TALL, size='down', export_profile='srgb')

    if base.interpretation not in ('srgb',) or base.format != 'uchar':
        base = base.colourspace('srgb').cast('uchar')
    return width, height, base.copy_memory()


def thumbhash_of(base: pyvips.Image) -> str:
    small = base.thumbnail_image(100, height=100)
    if small.bands == 3:
        small = small.bandjoin(255)
    return thumbhash_b64(small.width, small.height, small.write_to_memory())
