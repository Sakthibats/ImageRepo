import numpy as np
import pytest

from preprocessing.thumbhash import thumbhash_b64
from conftest import JS, run_js


@pytest.mark.parametrize('w, h, alpha', [(40, 30, False), (30, 40, True), (100, 75, False), (1, 1, False)])
def test_matches_the_npm_encoder(tmp_path, w, h, alpha):
    rng = np.random.default_rng(w * h)
    px = rng.integers(0, 256, size=(h, w, 4), dtype=np.uint8)
    if not alpha:
        px[..., 3] = 255
    f = tmp_path / 'rgba'
    f.write_bytes(px.tobytes())
    expected = run_js(str(JS / 'thumbhash.ts'), str(w), str(h), str(f)).decode()
    assert thumbhash_b64(w, h, px.tobytes()) == expected
