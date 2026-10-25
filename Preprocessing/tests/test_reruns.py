"""Re-running stages on media already in the library, from what R2 keeps."""
import io

import pytest
import pyvips
from PIL import Image

from preprocessing import keys
from preprocessing.runner import Runner
from preprocessing.stages import STAGES
from conftest import CFG, FakeApi, FakeR2, run, upload, write_photo

WIDTHS = (320, 1024, 2048)


def size(body: bytes) -> tuple[int, int]:
    im = pyvips.Image.new_from_buffer(body, '')
    return im.width, im.height


def uploaded(r2: FakeR2, path) -> dict:
    """A photo through the uploads path: the record, with its files in R2."""
    api = FakeApi([upload(r2, path)])
    run(api, r2)
    return api.completed[0]


def rerun(r2: FakeR2, item: dict, stage: str = 'derivatives') -> dict:
    api = FakeApi([], {(item['kind'], stage): [item]})
    run(api, r2)
    [report] = api.reported
    return report


@pytest.mark.parametrize('orientation', [3, 6, 8])
def test_a_turned_photo_reruns_upright_from_its_stripped_original(tmp_path, orientation):
    r2 = FakeR2()
    rec = uploaded(r2, write_photo(tmp_path / 'IMG.jpg', 4000, 3000, orientation=orientation))
    id = rec['id']
    with Image.open(io.BytesIO(r2.objects[keys.original(id, 'jpg')])) as im:
        assert not im.getexif().get(0x0112), 'stripping takes the orientation out of the original'
    first = {w: r2.objects.pop(keys.derivative(id, w)) for w in WIDTHS}

    r = rerun(r2, {'id': id, 'kind': 'photo', 'ext': 'jpg', 'orientation': orientation})
    assert r['state'] == 'done' and r['version'] == STAGES['photo'][2].version and r['rewrote'] is True
    assert (r['fields']['width'], r['fields']['height']) == (rec['width'], rec['height'])
    again = {w: r2.objects[keys.derivative(id, w)] for w in WIDTHS}
    assert {w: size(b) for w, b in again.items()} == {w: size(b) for w, b in first.items()}
    a, b = (pyvips.Image.new_from_buffer(x[320], '') for x in (first, again))
    assert (a - b).abs().avg() < 4, 'the same picture, the same way up'


def test_without_its_orientation_a_turned_photo_would_come_out_sideways(tmp_path):
    r2 = FakeR2()
    rec = uploaded(r2, write_photo(tmp_path / 'IMG.jpg', 4000, 3000, orientation=6))
    r = rerun(r2, {'id': rec['id'], 'kind': 'photo', 'ext': 'jpg'})
    assert (r['fields']['width'], r['fields']['height']) == (4000, 3000)


def test_uploads_go_before_reruns(tmp_path):
    r2 = FakeR2()
    rec = uploaded(r2, write_photo(tmp_path / 'old.jpg'))
    waiting = [upload(r2, write_photo(tmp_path / f'new{i}.jpg', 800 + i, 600)) for i in range(3)]
    api = FakeApi(waiting, {('photo', 'derivatives'): [{'id': rec['id'], 'kind': 'photo', 'ext': 'jpg'}]})
    run(api, r2)
    assert len(api.completed) == 3 and len(api.reported) == 1
    assert not any(uploads_waiting for *_, uploads_waiting in api.stage_claims), \
        'a re-run is never claimed while an upload waits'


def test_a_stage_with_nothing_to_rerun_is_not_asked_about_on_every_poll():
    api = FakeApi([])
    runner = Runner(CFG, api, FakeR2())
    assert runner.claim_reruns(4) == [] and runner.claim_reruns(4) == []
    assert [(k, s) for k, s, *_ in api.stage_claims] == [('photo', 'derivatives'), ('video', 'poster'), ('video', 'preview')]


def test_only_stages_that_can_run_from_the_original_are_rerun():
    runner = Runner(CFG, FakeApi([]), FakeR2())
    assert [(k, s.name) for k, s in runner.reruns] == [('photo', 'derivatives'), ('video', 'poster'), ('video', 'preview')]


def test_a_missing_original_is_given_up_on():
    r = rerun(FakeR2(), {'id': 'a' * 32, 'kind': 'photo', 'ext': 'jpg'})
    assert r['state'] == 'failed' and r['permanent'] and 'not in storage' in r['error']
