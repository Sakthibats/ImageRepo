import hashlib
import io

import pytest
from PIL import Image

from preprocessing.strip import StripError, strip_metadata
from conftest import EXPECTED, FIXTURES, decode


@pytest.mark.parametrize('name', ['phone.jpg', 'phone.png', 'phone.heic'])
def test_same_bytes_as_the_typescript_original(name):
    out = strip_metadata((FIXTURES / name).read_bytes(), name.split('.')[1]).data
    assert hashlib.sha256(out).hexdigest() == EXPECTED['strip'][name]


@pytest.mark.parametrize('ext', ['jpg', 'png', 'heic'])
def test_location_is_gone_and_pixels_are_not(photos, ext):
    raw = photos[ext].read_bytes()
    result = strip_metadata(raw, ext)
    assert result.removed_bytes > 0 and result.stripped

    with Image.open(io.BytesIO(raw)) as im:
        assert im.getexif().get_ifd(0x8825), 'the fixture should carry GPS'
    with Image.open(io.BytesIO(result.data)) as im:
        exif = im.getexif()
        assert not exif.get_ifd(0x8825) and 0x0110 not in exif
    assert b'gps-secret' not in result.data
    assert decode(result.data) == decode(raw)


def test_jpeg_keeps_its_colour_profile(photos):
    with Image.open(io.BytesIO(strip_metadata(photos['jpg'].read_bytes(), 'jpg').data)) as im:
        assert im.info.get('icc_profile')


def test_a_format_with_no_stripper_is_refused():
    with pytest.raises(StripError):
        strip_metadata(b'RIFF....WEBP', 'webp')


def test_a_damaged_heic_is_refused_not_passed_through(photos):
    raw = photos['heic'].read_bytes()
    with pytest.raises(StripError):
        strip_metadata(raw[:200], 'heic')
