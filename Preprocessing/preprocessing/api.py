"""The Worker's /admin/inbox routes, called with the service's Access token."""
import time
from typing import Any

import httpx

from .config import Config


class AuthError(Exception):
    pass


class WorkerApi:
    def __init__(self, cfg: Config, transport: httpx.BaseTransport | None = None):
        self.runner = cfg.runner
        self.http = httpx.Client(
            base_url=cfg.worker_url,
            headers={
                'CF-Access-Client-Id': cfg.access_client_id,
                'CF-Access-Client-Secret': cfg.access_client_secret,
            },
            timeout=httpx.Timeout(60.0, connect=15.0),
            # Access answers a bad token with a redirect to its login page.
            follow_redirects=False,
            transport=transport,
        )

    def _call(self, method: str, path: str, body: Any = None) -> Any:
        delay = 1.0
        for attempt in range(5):
            try:
                r = self.http.request(method, path, json=body)
            except httpx.TransportError:
                if attempt == 4:
                    raise
            else:
                if r.is_redirect or r.status_code in (401, 403):
                    raise AuthError(f'{path}: the Worker refused the service token ({r.status_code})')
                if r.status_code < 500:
                    if r.status_code >= 400:
                        raise RuntimeError(f'{path}: {r.status_code} {r.text[:200]}')
                    return r.json()
                if attempt == 4:
                    r.raise_for_status()
            time.sleep(delay)
            delay = min(delay * 3, 30)

    def health(self) -> dict:
        return self._call('GET', '/admin/health')

    def claim(self, limit: int, kinds: tuple[str, ...], lease_seconds: int = 900) -> list[dict]:
        r = self._call('POST', '/admin/inbox/claim', {
            'runner': self.runner, 'limit': limit, 'kinds': list(kinds), 'leaseSeconds': lease_seconds,
        })
        return r['items']

    def complete(self, records: list[dict]) -> dict:
        return self._call('POST', '/admin/inbox/complete', {'runner': self.runner, 'records': records})

    def fail(self, items: list[dict]) -> dict:
        return self._call('POST', '/admin/inbox/fail', {'runner': self.runner, 'items': items})

    def summary(self) -> dict:
        return self._call('GET', '/admin/inbox/summary')
