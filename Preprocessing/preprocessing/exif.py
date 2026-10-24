"""Reads photo metadata BEFORE anything is stripped: this is what reaches D1.

GPS is read here and stored in D1, owner-side only. It is never left in
anything written to R2 (see strip/ and images.py).
"""
import json
import math
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from PIL import ExifTags, Image, TiffImagePlugin
import pillow_heif

pillow_heif.register_heif_opener()

IFD_EXIF, IFD_GPS = 0x8769, 0x8825
# Pointers to other IFDs, not values.
POINTERS = {IFD_EXIF, IFD_GPS, 0xA005}

# IFD0
MAKE, MODEL, ORIENTATION, MODIFY_DATE = 0x010F, 0x0110, 0x0112, 0x0132
# Exif IFD
DATE_ORIGINAL, CREATE_DATE = 0x9003, 0x9004
OFFSET_TIME, OFFSET_ORIGINAL, OFFSET_DIGITIZED = 0x9010, 0x9011, 0x9012
ISO, FNUMBER, FOCAL, LENS = 0x8827, 0x829D, 0x920A, 0xA434

MAX_RAW_META = 24 * 1024


def read_exif(path: Path, photo_tz: str) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """The fields the library models, and every other tag as plain JSON.

    Unreadable metadata is not fatal: the photo still goes in, dated by its
    filename or the time it was last modified.
    """
    try:
        with Image.open(path) as im:
            exif = im.getexif()
            ifd0 = dict(exif)
            sub = dict(exif.get_ifd(IFD_EXIF))
            gps = dict(exif.get_ifd(IFD_GPS))
    except Exception:
        return {}, None

    make = text(ifd0.get(MAKE))
    model = text(ifd0.get(MODEL))
    lat, lon = coordinates(gps)
    fields = {
        'takenAt': taken_at(sub, ifd0, photo_tz),
        # Model is self-identifying on essentially every camera and phone
        # ("iPhone 14 Pro", "Canon EOS R5"), so it is preferred alone.
        'camera': model or make or None,
        'lens': text(sub.get(LENS)) or None,
        'iso': number(first(sub.get(ISO))),
        'fstop': number(sub.get(FNUMBER)),
        'focalMm': number(sub.get(FOCAL)),
        'lat': lat,
        'lon': lon,
        'orientation': number(ifd0.get(ORIENTATION)),
    }
    return {k: v for k, v in fields.items() if v is not None}, raw_meta(ifd0, sub, gps, lat, lon)


def taken_at(sub: dict, ifd0: dict, photo_tz: str) -> int | None:
    """Epoch seconds. EXIF times have no zone unless the camera wrote an
    OffsetTime tag (phones do); without one, they are read in `photo_tz`."""
    for tag, offset_tag in ((DATE_ORIGINAL, OFFSET_ORIGINAL), (CREATE_DATE, OFFSET_DIGITIZED),
                            (MODIFY_DATE, OFFSET_TIME)):
        raw = text((ifd0 if tag == MODIFY_DATE else sub).get(tag))
        m = re.match(r'(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})', raw or '')
        if not m:
            continue
        try:
            naive = datetime(*map(int, m.groups()))
        except ValueError:
            continue                            # "0000:00:00 00:00:00" and the like
        tz = offset(text(sub.get(offset_tag)) or text(sub.get(OFFSET_TIME))) or ZoneInfo(photo_tz)
        return int(naive.replace(tzinfo=tz).timestamp())
    return None


def offset(raw: str | None) -> timezone | None:
    m = re.fullmatch(r'([+-])(\d{2}):?(\d{2})', (raw or '').strip())
    if not m:
        return None
    delta = timedelta(hours=int(m[2]), minutes=int(m[3]))
    return timezone(-delta if m[1] == '-' else delta)


def coordinates(gps: dict) -> tuple[float | None, float | None]:
    def degrees(dms: Any, ref: Any, negative: str) -> float | None:
        try:
            d, m, s = (float(x) for x in dms)
        except (TypeError, ValueError):
            return None
        value = d + m / 60 + s / 3600
        if not math.isfinite(value):
            return None
        return -value if text(ref).upper() == negative else value

    lat = degrees(gps.get(2), gps.get(1), 'S')
    lon = degrees(gps.get(4), gps.get(3), 'W')
    return (lat, lon) if lat is not None and lon is not None else (None, None)


def date_from_filename(name: str) -> int | None:
    """Fallback when EXIF has no date: common phone filename patterns, as UTC.
    IMG_20231215_143022.jpg, 20231215_143022.jpg, PXL_20231215_143022123.jpg"""
    m = re.search(r'(20\d{2})(\d{2})(\d{2})[_-]?(\d{2})?(\d{2})?(\d{2})?', name)
    if not m:
        return None
    y, mo, d = m[1], m[2], m[3]
    h, mi, s = m[4] or '12', m[5] or '00', m[6] or '00'
    try:
        return int(datetime(int(y), int(mo), int(d), int(h), int(mi), int(s), tzinfo=timezone.utc).timestamp())
    except ValueError:
        return None


def raw_meta(ifd0: dict, sub: dict, gps: dict, lat: float | None, lon: float | None) -> dict | None:
    """Every tag the camera wrote, as plain JSON, named as Pillow names them.
    The original in R2 is stripped, so this is the only copy a later stage can
    read. Contains GPS: owner-side only."""
    out: dict[str, Any] = {}
    for tags, names in ((ifd0, ExifTags.TAGS), (sub, ExifTags.TAGS), (gps, ExifTags.GPSTAGS)):
        for tag, value in tags.items():
            if tag in POINTERS:
                continue
            v = plain(value)
            if v is not None:
                out[names.get(tag, f'0x{tag:04x}')] = v
    if lat is not None:
        out['latitude'], out['longitude'] = lat, lon
    if not out:
        return None
    return out if len(json.dumps(out)) <= MAX_RAW_META else None


def plain(v: Any) -> Any:
    """JSON-safe, dropping binary blobs, long strings and nested structures."""
    if isinstance(v, TiffImagePlugin.IFDRational):
        return number(v)
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return v if math.isfinite(v) else None
    if isinstance(v, str):
        v = v.rstrip('\0')
        return v if len(v) <= 500 else None
    if isinstance(v, (tuple, list)) and len(v) <= 16:
        items = [plain(x) for x in v]
        return [x for x in items if x is not None]
    return None                                 # bytes, maker notes, nested IFDs


def text(v: Any) -> str:
    if isinstance(v, bytes):
        v = v.decode('utf-8', 'replace')
    return v.strip().rstrip('\0').strip() if isinstance(v, str) else ''


def first(v: Any) -> Any:
    return v[0] if isinstance(v, (tuple, list)) and v else v


def number(v: Any) -> float | int | None:
    try:
        f = float(v)
    except (TypeError, ValueError, ZeroDivisionError):
        return None
    if not math.isfinite(f):
        return None
    return int(f) if f.is_integer() else f
