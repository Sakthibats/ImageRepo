"""The processing pipeline, in order, for each kind of file.

Names and versions are shared with D1's media_stages table: a stage at a new
version, or a new stage, is what turns existing media into a backlog. To add
processing (faces, objects), write a Stage and append it here.
"""
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Protocol


@dataclass
class Job:
    """One claimed upload, downloaded and checked against its id."""
    id: str
    kind: str
    ext: str
    orig_name: str
    last_modified: int | None
    path: Path                     # the file as uploaded, metadata intact; never put in R2 as-is
    work: Path                     # scratch space for this job's outputs, removed afterwards
    put: Callable[[str, bytes, str], None]
    put_file: Callable[[str, Path, str], None]      # large outputs, streamed from disk
    photo_tz: str


class Stage(Protocol):
    name: str
    version: int

    def run(self, job: Job, data: dict[str, Any]) -> dict[str, Any]:
        """Uploads its own output with job.put and returns small JSON.
        `data` holds what earlier stages returned, by stage name."""
        ...


class PermanentError(Exception):
    """A file that will never process, however often it is retried."""


from .photo import Exif, Original, Derivatives  # noqa: E402
from .video import Probe, VideoOriginal, Poster, Preview  # noqa: E402

STAGES: dict[str, list[Stage]] = {
    'photo': [Exif(), Original(), Derivatives()],
    'video': [Probe(), VideoOriginal(), Poster(), Preview()],
}
