import base64
import io

import pytest
from PIL import Image

from preprocessing.images import process_photo
from conftest import write_photo


def opened(body: bytes) -> Image.Image:
    im = Image.open(io.BytesIO(body))
    im.load()
    return im


def test_a_rotated_photo_comes_out_upright_at_every_width(tmp_path):
    # Stored landscape, marked as turned: displayed portrait.
    r = process_photo(write_photo(tmp_path / 'a.jpg', 4000, 3000, orientation=6), 'jpg')
    assert (r.width, r.height) == (3000, 4000)
    assert [d.name for d in r.derivatives] == ['320', '1024', '2048']
    for d in r.derivatives:
        im = opened(d.body)
        assert im.format == 'AVIF' and im.width == d.width and abs(im.height - d.width * 4 / 3) <= 1


@pytest.mark.parametrize('ext', ['jpg', 'png', 'heic'])
def test_derivatives_carry_no_metadata(tmp_path, ext):
    r = process_photo(write_photo(tmp_path / f'a.{ext}', 1200, 900), ext)
    for d in r.derivatives:
        im = opened(d.body)
        assert not im.getexif() and 'xmp' not in im.info and 'icc_profile' not in im.info
        assert b'Exif' not in d.body and b'iPhone' not in d.body and b'gps-secret' not in d.body


def test_small_photos_are_never_upscaled(tmp_path):
    r = process_photo(write_photo(tmp_path / 'a.jpg', 900, 600), 'jpg')
    assert [d.name for d in r.derivatives] == ['320']
    r = process_photo(write_photo(tmp_path / 'b.jpg', 200, 150), 'jpg')
    # The grid thumbnail is always made, but at the photo's own size.
    assert [d.name for d in r.derivatives] == ['320'] and opened(r.derivatives[0].body).width == 200


def test_heic_from_an_iphone(tmp_path):
    r = process_photo(write_photo(tmp_path / 'a.heic', 1600, 1200), 'heic')
    assert (r.width, r.height) == (1600, 1200)
    assert [d.name for d in r.derivatives] == ['320', '1024']


def test_transparency_and_greyscale(tmp_path):
    rgba = process_photo(write_photo(tmp_path / 'a.png', 400, 300, mode='RGBA'), 'png')
    assert base64.b64decode(rgba.thumbhash)[2] & 0x80, 'the hash should say it has alpha'
    grey = process_photo(write_photo(tmp_path / 'b.jpg', 400, 300, mode='L'), 'jpg')
    assert opened(grey.derivatives[0].body).width == 320


def test_thumbhash_is_small(tmp_path):
    r = process_photo(write_photo(tmp_path / 'a.jpg', 1200, 900), 'jpg')
    assert 20 <= len(base64.b64decode(r.thumbhash)) <= 30
