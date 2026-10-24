"""ffprobe and ffmpeg, as packages/ingest/src/video.ts uses them."""
import functools
import json
import re
import shutil
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any

PREVIEW_HEIGHT = 720
SCALE = f"scale=-2:'min({PREVIEW_HEIGHT},ih)'"


class FfmpegError(RuntimeError):
    pass


def available() -> bool:
    return bool(shutil.which('ffmpeg') and shutil.which('ffprobe'))


def run(args: list[str]) -> str:
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode:
        last = (r.stderr.strip().splitlines() or ['failed'])[-1]
        raise FfmpegError(f'{args[0]}: {last[:300]}')
    return r.stdout


def probe(path: Path) -> dict[str, Any]:
    """Stream and container metadata, read without decoding a frame."""
    data = json.loads(run(['ffprobe', '-v', 'quiet', '-print_format', 'json',
                           '-show_streams', '-show_format', str(path)]))
    v = next((s for s in data.get('streams', []) if s.get('codec_type') == 'video'), None)
    if not v:
        raise FfmpegError('no video stream')
    fmt = data.get('format') or {}
    tags = {**(fmt.get('tags') or {}), **(v.get('tags') or {})}

    # Apple writes location as "+15.4909+073.8278/" in com.apple.quicktime.location.ISO6709.
    iso6709 = tags.get('com.apple.quicktime.location.ISO6709') or tags.get('location') or ''
    geo = re.match(r'([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)', iso6709)
    # Rotation can live in a display-matrix side-data entry rather than a tag.
    matrix = next((s['rotation'] for s in v.get('side_data_list') or [] if 'rotation' in s), None)
    rotation = abs(int(float(matrix if matrix is not None else tags.get('rotate', 0) or 0))) % 360

    out: dict[str, Any] = {
        'width': int(v.get('width') or 0),
        'height': int(v.get('height') or 0),
        'durationMs': int(float(fmt.get('duration') or v.get('duration') or 0) * 1000 + 0.5),
        'codec': str(v.get('codec_name') or '').lower(),
        'rotation': rotation,
    }
    created = parse_time(tags.get('creation_time'))
    if created is not None:
        out['createdAt'] = created
    if geo:
        out['lat'], out['lon'] = float(geo[1]), float(geo[2])
    raw = {k: val for k, val in list(tags.items())[:64] if isinstance(val, str) and len(val) <= 500}
    if raw:
        out['raw'] = raw
    return out


def parse_time(value: Any) -> int | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        t = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        return None
    if t.tzinfo is None:
        return None                         # creation_time is UTC by spec; a bare one is untrustworthy
    return int(t.timestamp())


def remux(src: Path, out: Path) -> None:
    """Lossless: streams copied, every metadata tag dropped (GPS with them),
    moov moved to the front so a browser can start playing before the file
    has all arrived. Rotation survives: it is stream side data, not a tag."""
    common = ['-map_metadata', '-1', '-map_chapters', '-1', '-movflags', '+faststart']
    try:
        run(['ffmpeg', '-v', 'error', '-i', str(src), *common, '-c', 'copy', '-y', str(out)])
    except FfmpegError:
        # Some phones record audio MP4 cannot hold (PCM in a .mov). The
        # picture stays as recorded; only the sound is re-encoded.
        run(['ffmpeg', '-v', 'error', '-i', str(src), *common, '-c:v', 'copy', '-c:a', 'aac', '-y', str(out)])


def poster(src: Path, duration_ms: int, out: Path) -> None:
    """A frame about 1s in, past the black opening frames, upright."""
    seek = '1' if duration_ms > 2000 else '0'
    run(['ffmpeg', '-v', 'error', '-ss', seek, '-i', str(src), '-frames:v', '1', '-q:v', '3',
         '-map_metadata', '-1', '-y', str(out)])


def web_playable(codec: str) -> bool:
    """Codecs Chrome, Firefox and Safari all play from a plain <video> tag."""
    return codec in ('h264', 'avc1')


@functools.cache
def has_videotoolbox() -> bool:
    try:
        return 'h264_videotoolbox' in run(['ffmpeg', '-hide_banner', '-encoders'])
    except (FfmpegError, OSError):
        return False


def preview(src: Path, out: Path) -> None:
    """720p H.264 for clips a browser cannot play (HEVC, which iPhones record).

    On Apple Silicon this decodes and encodes in hardware: measured in the
    CLI, 9s instead of 34s for a 27s 2.7K HEVC clip, most of it the decode.
    Anywhere else, or if the hardware path fails on a file, libx264.
    """
    tail = ['-map_metadata', '-1', '-vf', SCALE, '-c:a', 'aac', '-b:a', '128k',
            '-movflags', '+faststart', '-y', str(out)]
    if has_videotoolbox():
        try:
            run(['ffmpeg', '-v', 'error', '-hwaccel', 'videotoolbox', '-i', str(src),
                 '-c:v', 'h264_videotoolbox', '-b:v', '2500k', *tail])
            return
        except FfmpegError:
            pass
    run(['ffmpeg', '-v', 'error', '-i', str(src),
         '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p', *tail])
