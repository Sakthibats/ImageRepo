import io
import json
import shutil
import subprocess

import pytest
from PIL import Image

from preprocessing import video
from preprocessing.runner import VIDEO_LEASE
from preprocessing.stages import STAGES
from conftest import FakeApi, FakeR2, run, upload, write_photo

pytestmark = pytest.mark.skipif(not shutil.which('ffmpeg'), reason='needs ffmpeg')

GPS = '+15.4909+073.8278/'


def ffmpeg(*args: str) -> None:
    subprocess.run(['ffmpeg', '-v', 'error', *args], check=True)


def ffprobe(data: bytes, tmp_path) -> dict:
    f = tmp_path / 'probe.mp4'
    f.write_bytes(data)
    out = subprocess.run(['ffprobe', '-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', str(f)],
                         check=True, capture_output=True, text=True).stdout
    return json.loads(out)


@pytest.fixture(scope='module')
def clips(tmp_path_factory):
    d = tmp_path_factory.mktemp('clips')
    tags = ['-metadata', f'location={GPS}', '-metadata', f'com.apple.quicktime.location.ISO6709={GPS}',
            '-metadata', 'creation_time=2023-12-15T14:30:22Z', '-metadata', 'make=Apple']
    # H.264, moov at the end: plays in browsers, but must be remuxed.
    ffmpeg('-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30:duration=3',
           '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
           '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', *tags,
           '-y', str(d / 'h264.mp4'))
    # HEVC, as an iPhone records, held sideways: a portrait clip.
    ffmpeg('-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=2',
           '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', *tags,
           '-y', str(d / 'flat.mov'))
    ffmpeg('-display_rotation', '90', '-i', str(d / 'flat.mov'), '-c', 'copy', '-map_metadata', '0',
           '-y', str(d / 'IMG_0001.MOV'))
    return {'h264': d / 'h264.mp4', 'hevc': d / 'IMG_0001.MOV'}


def test_probe(clips):
    p = video.probe(clips['h264'])
    assert (p['width'], p['height'], p['codec']) == (1280, 720, 'h264')
    assert abs(p['durationMs'] - 3000) < 200
    assert (p['lat'], p['lon']) == (15.4909, 73.8278)
    assert p['createdAt'] == 1_702_650_622
    assert video.probe(clips['hevc'])['rotation'] == 90


def test_a_video_becomes_a_record_with_its_objects(clips, tmp_path):
    r2 = FakeR2()
    items = [upload(r2, clips['h264'], kind='video'), upload(r2, clips['hevc'], kind='video')]
    api = FakeApi(items)
    assert run(api, r2) == 2 and not api.failed
    flat, turned = (next(r for r in api.completed if r['id'] == i['id']) for i in items)

    assert flat['kind'] == 'video' and flat['ext'] == 'mp4' and (flat['width'], flat['height']) == (1280, 720)
    assert (flat['lat'], flat['lon']) == (15.4909, 73.8278) and flat['takenAt'] == 1_702_650_622
    assert flat['rawMeta']['location'] == GPS, 'the container tags are kept for D1'
    assert flat['stages'] == [{'name': s.name, 'version': s.version} for s in STAGES['video']]
    # H.264 plays as it is; HEVC gets a preview.
    assert flat['derivatives'] == ['poster', '320', '1024']
    assert turned['derivatives'] == ['poster', '320', 'preview']
    assert (turned['width'], turned['height']) == (360, 640), 'portrait, as displayed'
    assert f'prev/{turned["id"]}.mp4' in r2.objects and f'prev/{flat["id"]}.mp4' not in r2.objects

    for rec in (flat, turned):
        stored = r2.objects[f'orig/{rec["id"]}.mp4']
        assert rec['bytes'] == len(stored)
        meta = ffprobe(stored, tmp_path)
        tags = {**meta['format'].get('tags', {}), **meta['streams'][0].get('tags', {})}
        assert not any('location' in k or k == 'make' for k in tags), f'metadata left in the original: {tags}'
        assert GPS.encode() not in stored
        # Streamable: moov before mdat.
        assert 0 <= stored.find(b'moov') < stored.find(b'mdat')

    # The stream itself is copied, not re-encoded, and keeps its rotation.
    meta = ffprobe(r2.objects[f'orig/{turned["id"]}.mp4'], tmp_path)
    v = meta['streams'][0]
    assert v['codec_name'] == 'hevc' and abs(next(s['rotation'] for s in v['side_data_list'] if 'rotation' in s)) == 90

    with Image.open(io.BytesIO(r2.objects[f'drv/{turned["id"]}/320.avif'])) as im:
        assert im.height > im.width, 'the poster is upright'
    with Image.open(io.BytesIO(r2.objects[f'post/{flat["id"]}.jpg'])) as im:
        assert im.size == (1280, 720) and not im.getexif()


def test_videos_take_few_slots_and_long_leases(clips, tmp_path):
    r2 = FakeR2()
    photos = [upload(r2, write_photo(tmp_path / f'p{i}.jpg')) for i in range(6)]
    api = FakeApi([upload(r2, clips['h264'], kind='video'), *photos])
    run(api, r2)
    video_claims = [c for c in api.claims if c[1] == ('video',)]
    assert video_claims and all(limit == 1 and lease == VIDEO_LEASE for limit, _, lease in video_claims)
    assert len(api.completed) == 7


def test_an_unreadable_video_is_given_up_on(tmp_path):
    r2 = FakeR2()
    junk = tmp_path / 'clip.mov'
    junk.write_bytes(b'\0' * 100)
    api = FakeApi([upload(r2, junk, kind='video')])
    run(api, r2)
    assert api.failed[0]['permanent'] is True and 'not a readable video' in api.failed[0]['error']
