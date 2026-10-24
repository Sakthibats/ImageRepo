"""Fixtures: small photos carrying the metadata a phone writes, GPS included."""
import io
import shutil
import subprocess
import threading
from pathlib import Path

import pillow_heif
import pytest
from PIL import Image, ImageCms
from PIL.TiffImagePlugin import IFDRational as R

from preprocessing.config import Config
from preprocessing.runner import Runner, content_id

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


# ------------------------------------------------------------- the runner

class FakeR2:
    def __init__(self):
        self.objects: dict[str, bytes] = {}

    def download(self, key, path):
        path.write_bytes(self.objects[key])

    def put(self, key, body, content_type):
        self.objects[key] = body

    def put_file(self, key, path, content_type):
        self.objects[key] = path.read_bytes()


class FakeApi:
    def __init__(self, items):
        self.queue = list(items)
        self.completed: list[dict] = []
        self.failed: list[dict] = []
        self.claims: list[tuple] = []

    def claim(self, limit, kinds, lease_seconds=900):
        self.claims.append((limit, kinds, lease_seconds))
        taken = [i for i in self.queue if i['kind'] in kinds][:limit]
        self.queue = [i for i in self.queue if i not in taken]
        return taken

    def complete(self, records):
        assert len(records) <= 20
        self.completed += records
        return {'recorded': len(records), 'skipped': []}

    def fail(self, items):
        self.failed += items


CFG = Config(worker_url='http://worker', access_client_id='x', access_client_secret='y',
             r2_account_id='a', r2_access_key_id='k', r2_secret_access_key='s', r2_bucket='b',
             runner='test', concurrency=2, kinds=('photo', 'video'), photo_tz='UTC',
             poll_seconds=0, flush_seconds=0)


def upload(r2: FakeR2, path, kind='photo', id=None, name=None):
    data = path.read_bytes()
    id = id or content_id(path)
    ext = path.suffix[1:].lower()
    r2.objects[f'inbox/{id}.{ext}'] = data
    return {'id': id, 'kind': kind, 'ext': ext, 'bytes': len(data), 'key': f'inbox/{id}.{ext}',
            'origName': name or path.name, 'lastModified': 1_600_000_000, 'albumId': 'trip', 'attempts': 0}


def run(api, r2):
    return Runner(CFG, api, r2).run(threading.Event(), once=True)
