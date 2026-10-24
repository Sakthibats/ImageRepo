"""Removes embedded metadata (and with it, location) without touching a pixel.

Ported from the retired TypeScript CLI (packages/ingest, in git history);
tests/test_strip.py checks the output is still byte-identical to it.
"""
from dataclasses import dataclass, field


@dataclass
class StripResult:
    data: bytes
    removed_bytes: int = 0
    stripped: list[str] = field(default_factory=list)


class StripError(ValueError):
    """The file could not be cleaned, so it must not be uploaded."""


def strip_metadata(data: bytes, ext: str) -> StripResult:
    from .heic import strip_heic
    from .jpeg import strip_jpeg
    from .png import strip_png

    if ext in ('jpg', 'jpeg'):
        return strip_jpeg(data)
    if ext == 'png':
        return strip_png(data)
    if ext in ('heic', 'heif'):
        return strip_heic(data)
    # Uploading a format we cannot clean would leak whatever it carries.
    raise StripError(f'no metadata stripper for .{ext}')


def unique(items: list[str]) -> list[str]:
    """First-seen order, as JavaScript's [...new Set(x)] gives."""
    return list(dict.fromkeys(items))
