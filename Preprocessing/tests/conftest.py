"""Fixtures: small photos carrying the metadata a phone writes, GPS included."""
import io
import shutil
import subprocess
from pathlib import Path

import pillow_heif
import pytest
from PIL import Image, ImageCms
from PIL.TiffImagePlugin import IFDRational as R

pillow_heif.register_heif_opener()

REPO = Path(__file__).resolve().parents[2]
JS = Path(__file__).resolve().parent / 'js'
TSX = REPO / 'node_modules' / '.bin' / 'tsx'
XMP = b'<x:xmpmeta><rdf:Description exif:GPSLatitude="33,51.9S" note="gps-secret"/></x:xmpmeta>'


def exif_block(orientation: int | None = None, offset: str | None = '+05:30', gps: bool = True) -> bytes:
    exif = Image.Exif()
    exif[0x010F] = 'Apple'
    exif[0x0110] = 'iPhone 15 Pro'
    if orientation:
        exif[0x0112] = orientation
    sub = {0x9003: '2023:12:15 14:30:22', 0x829D: R(9, 5), 0x920A: R(677, 100), 0x8827: 125,
           0xA434: 'iPhone 15 Pro back camera 6.86mm f/1.78'}
    if offset:
        sub[0x9011] = offset
    exif[0x8769] = sub
    if gps:
        exif[0x8825] = {1: 'S', 2: (R(33, 1), R(51, 1), R(54, 1)), 3: 'E', 4: (R(151, 1), R(12, 1), R(36, 1))}
    return exif.tobytes()


def picture(w: int, h: int, mode: str = 'RGB') -> Image.Image:
    """A gradient, so resizing and decoding have something to get wrong."""
    im = Image.linear_gradient('L').resize((w, h))
    if mode == 'L':
        return im
    bands = [im, im.transpose(Image.Transpose.FLIP_LEFT_RIGHT), im.transpose(Image.Transpose.FLIP_TOP_BOTTOM)]
    if mode == 'RGBA':
        bands.append(Image.new('L', (w, h), 128))
    return Image.merge(mode, bands)


def write_photo(path: Path, w: int = 640, h: int = 480, mode: str = 'RGB', **exif) -> Path:
    im = picture(w, h, mode)
    ext = path.suffix.lower()
    if ext in ('.jpg', '.jpeg'):
        icc = ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes()
        im.save(path, 'JPEG', quality=88, exif=exif_block(**exif), xmp=XMP, icc_profile=icc)
    elif ext == '.png':
        from PIL.PngImagePlugin import PngInfo
        info = PngInfo()
        info.add_itxt('XML:com.adobe.xmp', XMP.decode())
        info.add_text('Comment', 'gps-secret')
        im.save(path, 'PNG', exif=exif_block(**exif), pnginfo=info)
    elif ext in ('.heic', '.heif'):
        im.save(path, 'HEIF', quality=80, exif=exif_block(**exif), xmp=XMP)
    else:
        raise ValueError(ext)
    return path


@pytest.fixture
def photos(tmp_path: Path) -> dict[str, Path]:
    return {
        'jpg': write_photo(tmp_path / 'IMG_1.jpg'),
        'png': write_photo(tmp_path / 'IMG_2.png', mode='RGBA'),
        'heic': write_photo(tmp_path / 'IMG_3.heic'),
    }


def run_js(*args: str) -> bytes:
    if not TSX.exists() or not shutil.which('node'):
        pytest.skip('needs node and the repo’s npm install, to compare with the TypeScript original')
    return subprocess.run([str(TSX), *args], check=True, capture_output=True, cwd=REPO).stdout


def decode(data: bytes) -> bytes:
    with Image.open(io.BytesIO(data)) as im:
        return im.convert('RGBA').tobytes()
