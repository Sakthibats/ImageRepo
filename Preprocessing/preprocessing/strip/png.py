"""Lossless PNG metadata removal.

A PNG is an 8-byte signature followed by chunks: length, type, data, CRC.
Location can sit in eXIf (raw EXIF) or a text chunk (XMP is an iTXt named
"XML:com.adobe.xmp"). Dropping whole chunks leaves the image data and every
remaining CRC untouched. Colour chunks (iCCP, sRGB, gAMA, cHRM) are kept.
"""
from . import StripError, StripResult, unique

SIGNATURE = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
STRIP = {'eXIf', 'tEXt', 'zTXt', 'iTXt'}


def strip_png(data: bytes) -> StripResult:
    if len(data) < 8 or data[:8] != SIGNATURE:
        raise StripError('not a PNG file')

    keep = [data[:8]]
    stripped: list[str] = []
    removed = 0
    p = 8
    while p + 12 <= len(data):
        length = int.from_bytes(data[p:p + 4], 'big')
        kind = data[p + 4:p + 8].decode('latin-1')
        end = p + 12 + length
        if end > len(data):
            raise StripError('truncated PNG chunk')
        if kind in STRIP:
            removed += end - p
            stripped.append(kind)
        else:
            keep.append(data[p:end])
        p = end
        if kind == 'IEND':
            break
    return StripResult(b''.join(keep), removed, unique(stripped))
