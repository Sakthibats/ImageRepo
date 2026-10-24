"""Lossless HEIC/HEIF metadata removal.

A HEIC file is a tree of boxes. Image and metadata are separate "items":
`iinf` names each item's type, `iloc` says which bytes it occupies. EXIF is an
item of type "Exif"; XMP is a "mime" item.

Removing an item would mean rewriting every offset in the file, so the
metadata bytes are overwritten in place instead: EXIF with a valid, empty EXIF
block, XMP with spaces. The file keeps its size and layout, and the coded image
is untouched. Rotation is safe: HEIC carries it in an `irot` property, not EXIF.

Anything this cannot parse is an error, never a pass-through.
"""
from dataclasses import dataclass
from typing import Iterator

from . import StripError, StripResult, unique


@dataclass
class Box:
    type: str
    start: int
    body: int
    end: int


def u16(b: bytes, p: int) -> int:
    return int.from_bytes(b[p:p + 2], 'big')


def u32(b: bytes, p: int) -> int:
    return int.from_bytes(b[p:p + 4], 'big')


def boxes(buf: bytes, start: int, end: int) -> Iterator[Box]:
    p = start
    while p + 8 <= end:
        size = u32(buf, p)
        kind = buf[p + 4:p + 8].decode('latin-1')
        header = 8
        if size == 1:
            if p + 16 > end:
                raise StripError('truncated box')
            size = int.from_bytes(buf[p + 8:p + 16], 'big')
            header = 16
        elif size == 0:
            size = end - p                      # "extends to end of file"
        if size < header or p + size > end:
            raise StripError(f'malformed {kind} box')
        yield Box(kind, p, p + header, p + size)
        p += size


def find(buf: bytes, start: int, end: int, kind: str) -> Box | None:
    return next((b for b in boxes(buf, start, end) if b.type == kind), None)


def uint(buf: bytes, p: int, size: int) -> int:
    if size not in (0, 2, 4, 8):
        raise StripError(f'unsupported field size {size}')
    return int.from_bytes(buf[p:p + size], 'big') if size else 0


def cstring(buf: bytes, p: int, end: int) -> tuple[str, int]:
    q = p
    while q < end and buf[q] != 0:
        q += 1
    return buf[p:q].decode('latin-1'), q + 1


def metadata_items(buf: bytes, iinf: Box) -> dict[int, str]:
    """item id -> 'Exif' or 'XMP', for the items we want gone."""
    out: dict[int, str] = {}
    version = buf[iinf.body]
    first = iinf.body + 4 + (2 if version == 0 else 4)
    for infe in boxes(buf, first, iinf.end):
        if infe.type != 'infe':
            continue
        v = buf[infe.body]
        if v < 2:
            continue                            # v0/v1 predate item types; HEIC uses v2+
        p = infe.body + 4
        item = u16(buf, p) if v == 2 else u32(buf, p)
        p += (2 if v == 2 else 4) + 2           # id, protection index
        kind = buf[p:p + 4].decode('latin-1')
        p += 4
        if kind == 'Exif':
            out[item] = 'Exif'
        elif kind == 'mime':
            _, nxt = cstring(buf, p, infe.end)
            content_type = cstring(buf, nxt, infe.end)[0].lower()
            if 'xml' in content_type or 'xmp' in content_type:
                out[item] = 'XMP'
    return out


def item_extents(buf: bytes, iloc: Box, idat: Box | None, wanted: dict[int, str]) -> dict[int, list[tuple[int, int]]]:
    """Absolute byte ranges of each wanted item, read from `iloc`."""
    version = buf[iloc.body]
    if version > 2:
        raise StripError(f'unsupported iloc version {version}')
    p = iloc.body + 4
    offset_size, length_size = buf[p] >> 4, buf[p] & 0x0F
    base_offset_size = buf[p + 1] >> 4
    index_size = buf[p + 1] & 0x0F if version > 0 else 0
    p += 2
    count = u16(buf, p) if version < 2 else u32(buf, p)
    p += 2 if version < 2 else 4

    out: dict[int, list[tuple[int, int]]] = {}
    for _ in range(count):
        item = u16(buf, p) if version < 2 else u32(buf, p)
        p += 2 if version < 2 else 4
        method = 0
        if version > 0:
            method = u16(buf, p) & 0x0F
            p += 2
        p += 2                                  # data reference index
        base = uint(buf, p, base_offset_size)
        p += base_offset_size
        extent_count = u16(buf, p)
        p += 2
        ranges = []
        for _ in range(extent_count):
            p += index_size
            offset = uint(buf, p, offset_size)
            p += offset_size
            length = uint(buf, p, length_size)
            p += length_size
            ranges.append((base + offset, length))
        if item not in wanted:
            continue
        # Method 0 is an offset into the file; 1 into the `idat` box.
        # Method 2 (another item's data) is never used for metadata.
        origin = 0 if method == 0 else idat.body if method == 1 and idat else -1
        if origin < 0:
            raise StripError(f'unsupported item construction method {method}')
        out[item] = [(origin + o, n) for o, n in ranges]
    return out


# A well-formed EXIF block with no tags: offset, "Exif\0\0", TIFF header, empty IFD.
EMPTY_EXIF = bytes([
    0, 0, 0, 6, 0x45, 0x78, 0x69, 0x66, 0, 0,
    0x4D, 0x4D, 0, 0x2A, 0, 0, 0, 8,
    0, 0, 0, 0, 0, 0,
])


def strip_heic(data: bytes) -> StripResult:
    if len(data) < 12 or data[4:8] != b'ftyp':
        raise StripError('not a HEIC/HEIF file')
    meta = find(data, 0, len(data), 'meta')
    if not meta:
        raise StripError('HEIC has no meta box')
    lo, hi = meta.body + 4, meta.end            # meta is a FullBox
    iinf, iloc = find(data, lo, hi, 'iinf'), find(data, lo, hi, 'iloc')
    if not iinf or not iloc:
        raise StripError('HEIC has no item table')

    wanted = metadata_items(data, iinf)
    if not wanted:
        return StripResult(data)
    extents = item_extents(data, iloc, find(data, lo, hi, 'idat'), wanted)

    out = bytearray(data)
    removed = 0
    for item, kind in wanted.items():
        ranges = extents.get(item)
        if ranges is None:
            raise StripError(f'HEIC {kind} item has no location')
        for i, (start, length) in enumerate(ranges):
            if start + length > len(out):
                raise StripError(f'HEIC {kind} item runs past end of file')
            out[start:start + length] = (b' ' if kind == 'XMP' else b'\0') * length
            if kind == 'Exif' and i == 0 and length >= len(EMPTY_EXIF):
                out[start:start + len(EMPTY_EXIF)] = EMPTY_EXIF
            removed += length
    return StripResult(bytes(out), removed, unique(list(wanted.values())))
