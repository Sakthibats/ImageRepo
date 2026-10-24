"""Lossless JPEG metadata surgery.

A JPEG is SOI (FFD8) followed by marker segments, then entropy-coded scan data
after SOS (FFDA). EXIF/GPS lives in APP1; XMP (which can also carry
coordinates) in a second APP1; IPTC in APP13. Dropping those segments removes
location without re-encoding anything. Deliberately kept: APP0 (JFIF density),
APP2 (ICC profile; dropping it visibly shifts colours), and everything that
makes up the image.
"""
from . import StripResult, unique

SOI, SOS, EOI = 0xD8, 0xDA, 0xD9
APP1, APP13 = 0xE1, 0xED
STRIP = {APP1, APP13}


def strip_jpeg(data: bytes) -> StripResult:
    if len(data) < 4 or data[0] != 0xFF or data[1] != SOI:
        # Not a JPEG we recognise: hand it back untouched rather than corrupt it.
        return StripResult(data)

    keep = [data[:2]]
    stripped: list[str] = []
    removed = 0
    p = 2
    n = len(data)

    while p < n - 1:
        if data[p] != 0xFF:
            break                                   # desync; bail out safely
        marker = data[p + 1]
        if marker == 0xFF:
            p += 1                                  # fill byte
            continue
        if marker in (EOI, SOS):
            # From SOS on it is scan data: copy verbatim and stop.
            keep.append(data[p:])
            p = n
            break
        if p + 4 > n:
            break
        length = int.from_bytes(data[p + 2:p + 4], 'big')   # includes its own 2 bytes
        if length < 2 or p + 2 + length > n:
            break
        segment = data[p:p + 2 + length]
        if marker in STRIP:
            removed += len(segment)
            stripped.append(f'APP{marker - 0xE0}')
        else:
            keep.append(segment)
        p += 2 + length

    # If we bailed mid-file, keep the remainder so an image is never truncated.
    if p < n:
        keep.append(data[p:])
    return StripResult(b''.join(keep), removed, unique(stripped))
