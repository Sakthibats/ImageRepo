from datetime import datetime

import pytest

from preprocessing.exif import date_from_filename, read_exif
from conftest import write_photo


def epoch(iso: str) -> int:
    return int(datetime.fromisoformat(iso).timestamp())


@pytest.mark.parametrize('ext', ['jpg', 'png', 'heic'])
def test_reads_what_a_phone_writes(tmp_path, ext):
    fields, raw = read_exif(write_photo(tmp_path / f'a.{ext}'), 'UTC')
    assert fields['camera'] == 'iPhone 15 Pro'
    assert fields['fstop'] == 1.8 and fields['focalMm'] == 6.77 and fields['iso'] == 125
    assert fields['lens'].startswith('iPhone 15 Pro back camera')
    assert fields['lat'] == pytest.approx(-33.865) and fields['lon'] == pytest.approx(151.21)
    # The camera's own offset wins over the configured zone.
    assert fields['takenAt'] == epoch('2023-12-15T14:30:22+05:30')
    assert raw['Model'] == 'iPhone 15 Pro' and raw['latitude'] == fields['lat']
    assert not any(isinstance(v, bytes) for v in raw.values())


def test_a_time_without_an_offset_is_read_in_the_configured_zone(tmp_path):
    fields, _ = read_exif(write_photo(tmp_path / 'a.jpg', offset=None), 'Asia/Singapore')
    assert fields['takenAt'] == epoch('2023-12-15T14:30:22+08:00')


def test_no_gps_means_no_location(tmp_path):
    fields, raw = read_exif(write_photo(tmp_path / 'a.jpg', gps=False), 'UTC')
    assert 'lat' not in fields and 'latitude' not in raw


def test_orientation(tmp_path):
    fields, _ = read_exif(write_photo(tmp_path / 'a.jpg', orientation=6), 'UTC')
    assert fields['orientation'] == 6


def test_unreadable_metadata_is_not_fatal(tmp_path):
    p = tmp_path / 'junk.jpg'
    p.write_bytes(b'not an image')
    assert read_exif(p, 'UTC') == ({}, None)


@pytest.mark.parametrize('name, iso', [
    ('IMG_20231215_143022.jpg', '2023-12-15T14:30:22+00:00'),
    ('PXL_20231215_143022123.jpg', '2023-12-15T14:30:22+00:00'),
    ('20231215.jpg', '2023-12-15T12:00:00+00:00'),
    ('Screenshot 2024-01-02 at 10.00.00.png', None),
    ('holiday.jpg', None),
])
def test_date_from_filename(name, iso):
    assert date_from_filename(name) == (epoch(iso) if iso else None)
