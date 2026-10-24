import io
import threading

import pytest
from PIL import Image

from preprocessing.config import Config
from preprocessing.runner import Runner, content_id
from preprocessing.stages import STAGES
from preprocessing.stages.photo import Derivatives
from conftest import write_photo


class FakeR2:
    def __init__(self):
        self.objects: dict[str, bytes] = {}

    def download(self, key, path):
        path.write_bytes(self.objects[key])

    def put(self, key, body, content_type):
        self.objects[key] = body


class FakeApi:
    def __init__(self, items):
        self.queue = list(items)
        self.completed: list[dict] = []
        self.failed: list[dict] = []

    def claim(self, limit, kinds):
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


def test_an_upload_becomes_a_record_with_its_objects(tmp_path):
    r2 = FakeR2()
    items = [upload(r2, write_photo(tmp_path / f'IMG_{i}.jpg', 2400, 1600, orientation=6)) for i in range(25)]
    api = FakeApi(items)
    assert run(api, r2) == 25
    assert len(api.completed) == 25 and not api.failed

    rec = next(r for r in api.completed if r['id'] == items[0]['id'])
    id = rec['id']
    assert rec['kind'] == 'photo' and rec['ext'] == 'jpg' and (rec['width'], rec['height']) == (1600, 2400)
    assert rec['derivatives'] == ['320', '1024'] and rec['camera'] == 'iPhone 15 Pro'
    assert rec['lat'] == pytest.approx(-33.865) and rec['rawMeta']['latitude'] == rec['lat']
    assert rec['stages'] == [{'name': s.name, 'version': s.version} for s in STAGES['photo']]
    assert rec['bytes'] == len(r2.objects[f'orig/{id}.jpg'])

    with Image.open(io.BytesIO(r2.objects[f'orig/{id}.jpg'])) as im:
        assert not im.getexif().get_ifd(0x8825), 'the original in R2 must have no GPS'
    assert {f'drv/{id}/320.avif', f'drv/{id}/1024.avif'} <= set(r2.objects)


def test_bytes_that_do_not_match_their_id_are_given_up_on(tmp_path):
    r2 = FakeR2()
    item = upload(r2, write_photo(tmp_path / 'a.jpg'), id='f' * 32)
    api = FakeApi([item])
    run(api, r2)
    assert api.failed == [{'id': 'f' * 32, 'error': api.failed[0]['error'], 'permanent': True}]
    assert not any(k.startswith(('orig/', 'drv/')) for k in r2.objects), 'nothing written under a wrong id'


def test_a_crash_in_a_stage_is_retried_not_given_up_on(tmp_path, monkeypatch):
    def boom(self, job, data):
        raise MemoryError('out of memory')
    monkeypatch.setattr(Derivatives, 'run', boom)
    r2 = FakeR2()
    api = FakeApi([upload(r2, write_photo(tmp_path / 'a.jpg'))])
    run(api, r2)
    assert len(api.failed) == 1 and 'permanent' not in api.failed[0] and 'out of memory' in api.failed[0]['error']


def test_date_falls_back_to_the_filename_then_the_file_time(tmp_path):
    r2 = FakeR2()
    plain = tmp_path / 'p.png'
    Image.new('RGB', (64, 48)).save(plain)
    named = tmp_path / 'IMG_20231215_143022.png'
    Image.new('RGB', (64, 49)).save(named)
    api = FakeApi([upload(r2, plain), upload(r2, named)])
    run(api, r2)
    by_name = {r['origName']: r for r in api.completed}
    assert by_name['p.png']['takenAt'] == 1_600_000_000
    assert by_name['IMG_20231215_143022.png']['takenAt'] == 1_702_650_622
    assert 'lat' not in by_name['p.png']


def test_a_kind_with_no_pipeline_yet_is_refused(tmp_path):
    r2 = FakeR2()
    clip = tmp_path / 'clip.mov'
    clip.write_bytes(b'\0' * 100)
    api = FakeApi([upload(r2, clip, kind='video')])
    run(api, r2)
    assert api.failed[0]['permanent'] is True
