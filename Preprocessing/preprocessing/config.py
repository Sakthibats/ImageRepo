"""Settings, from the environment. Outside Docker, Preprocessing/.env fills in
whatever the environment does not already set."""
import os
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class Config:
    worker_url: str
    access_client_id: str
    access_client_secret: str
    r2_account_id: str
    r2_access_key_id: str
    r2_secret_access_key: str
    r2_bucket: str
    runner: str
    concurrency: int
    kinds: tuple[str, ...]
    photo_tz: str
    poll_seconds: float = 5.0
    # Records go to the Worker in batches, and each batch re-bakes the album.
    # This caps how long a finished photo waits to appear.
    flush_seconds: float = 5.0


REQUIRED = [
    'WORKER_URL', 'CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_SECRET',
    'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY',
]


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def load() -> Config:
    load_dotenv(ROOT / '.env')
    missing = [k for k in REQUIRED if not os.environ.get(k)]
    if missing:
        raise ConfigError(f'missing settings: {", ".join(missing)} (see env.example)')
    env = os.environ
    kinds = tuple(k.strip() for k in env.get('KINDS', 'photo').split(',') if k.strip())
    return Config(
        worker_url=env['WORKER_URL'].rstrip('/'),
        access_client_id=env['CF_ACCESS_CLIENT_ID'],
        access_client_secret=env['CF_ACCESS_CLIENT_SECRET'],
        r2_account_id=env['R2_ACCOUNT_ID'],
        r2_access_key_id=env['R2_ACCESS_KEY_ID'],
        r2_secret_access_key=env['R2_SECRET_ACCESS_KEY'],
        r2_bucket=env.get('R2_BUCKET', 'imagerepo'),
        runner=env.get('RUNNER_NAME', 'preprocess')[:40],
        concurrency=max(1, int(env.get('CONCURRENCY') or os.cpu_count() or 2)),
        kinds=kinds,
        photo_tz=env.get('PHOTO_TZ', 'UTC'),
    )
