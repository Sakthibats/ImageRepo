"""ThumbHash encoder: a ~25-byte blurred placeholder the app shows while the
real image loads. A port of rgbaToThumbHash from the `thumbhash` npm package,
which the web app decodes; tests/test_thumbhash.py checks they agree.
"""
import base64
import math

import numpy as np


def js_round(x: float) -> int:
    """JavaScript's Math.round: halves go up, unlike Python's round()."""
    return math.floor(x + 0.5)


def rgba_to_thumbhash(w: int, h: int, rgba: bytes) -> bytes:
    if w > 100 or h > 100:
        raise ValueError(f"{w}x{h} doesn't fit in 100x100")
    px = np.frombuffer(rgba, dtype=np.uint8).reshape(h, w, 4).astype(np.float64)
    alpha = px[..., 3] / 255

    # Average colour, weighted by alpha.
    avg_a = alpha.sum()
    if avg_a:
        avg = (alpha[..., None] / 255 * px[..., :3]).sum(axis=(0, 1)) / avg_a
    else:
        avg = np.zeros(3)

    has_alpha = avg_a < w * h
    l_limit = 5 if has_alpha else 7             # fewer luminance bits if there's alpha
    lx = max(1, js_round(l_limit * w / max(w, h)))
    ly = max(1, js_round(l_limit * h / max(w, h)))

    # RGBA to LPQA, composited atop the average colour.
    rgb = avg * (1 - alpha[..., None]) + alpha[..., None] / 255 * px[..., :3]
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    l, p, q = (r + g + b) / 3, (r + g) / 2 - b, r - g

    xs, ys = np.arange(w) + 0.5, np.arange(h) + 0.5

    def encode(channel: np.ndarray, nx: int, ny: int) -> tuple[float, list[float], float]:
        dc, ac, scale = 0.0, [], 0.0
        for cy in range(ny):
            cx = 0
            while cx * ny < nx * (ny - cy):
                fx = np.cos(math.pi / w * cx * xs)
                fy = np.cos(math.pi / h * cy * ys)
                f = float((channel * fy[:, None] * fx[None, :]).sum()) / (w * h)
                if cx or cy:
                    ac.append(f)
                    scale = max(scale, abs(f))
                else:
                    dc = f
                cx += 1
        if scale:
            ac = [0.5 + 0.5 / scale * f for f in ac]
        return dc, ac, scale

    l_dc, l_ac, l_scale = encode(l, max(3, lx), max(3, ly))
    p_dc, p_ac, p_scale = encode(p, 3, 3)
    q_dc, q_ac, q_scale = encode(q, 3, 3)
    a_dc, a_ac, a_scale = encode(alpha, 5, 5) if has_alpha else (0.0, [], 0.0)

    landscape = w > h
    header24 = (js_round(63 * l_dc) | (js_round(31.5 + 31.5 * p_dc) << 6)
                | (js_round(31.5 + 31.5 * q_dc) << 12) | (js_round(31 * l_scale) << 18)
                | (int(has_alpha) << 23))
    header16 = ((ly if landscape else lx) | (js_round(63 * p_scale) << 3)
                | (js_round(63 * q_scale) << 9) | (int(landscape) << 15))
    out = [header24 & 255, (header24 >> 8) & 255, header24 >> 16, header16 & 255, header16 >> 8]
    ac_start = 6 if has_alpha else 5
    if has_alpha:
        out.append(js_round(15 * a_dc) | (js_round(15 * a_scale) << 4))

    i = 0
    for ac in ([l_ac, p_ac, q_ac, a_ac] if has_alpha else [l_ac, p_ac, q_ac]):
        for f in ac:
            at = ac_start + (i >> 1)
            while len(out) <= at:
                out.append(0)
            out[at] |= js_round(15 * f) << ((i & 1) << 2)
            i += 1
    return bytes(out)


def thumbhash_b64(w: int, h: int, rgba: bytes) -> str:
    return base64.b64encode(rgba_to_thumbhash(w, h, rgba)).decode()
