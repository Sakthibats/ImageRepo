import numpy as np
import pytest

from preprocessing.thumbhash import thumbhash_b64
from conftest import EXPECTED


@pytest.mark.parametrize('w, h, alpha', [(40, 30, False), (30, 40, True), (100, 75, False), (1, 1, False)])
def test_matches_the_npm_encoder(w, h, alpha):
    # PCG64 streams are stable across numpy versions, so these are the inputs
    # the expected hashes were made from.
    px = np.random.default_rng(w * h).integers(0, 256, size=(h, w, 4), dtype=np.uint8)
    if not alpha:
        px[..., 3] = 255
    assert thumbhash_b64(w, h, px.tobytes()) == EXPECTED['thumbhash'][f'{w}x{h}{"a" if alpha else ""}']
