import type { MediaRecord } from '@imagerepo/shared';
import type { Config } from './config.js';

/**
 * Posts metadata to the Worker, which owns all D1 writes. The CLI never talks
 * to the database directly — one writer keeps the schema in one place.
 */
export class AdminApi {
  constructor(private cfg: Config) {}

  get configured() { return Boolean(this.cfg.apiUrl && this.cfg.adminToken); }

  private async post(path: string, body: unknown) {
    const res = await fetch(`${this.cfg.apiUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${this.cfg.adminToken}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`${path} -> ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 300)}`);
    }
    return res.json();
  }

  /** Batched so 13,000 photos are a few hundred requests, not 13,000. */
  recordMedia(records: MediaRecord[]) {
    return this.post('/admin/ingest', { records });
  }

  ensureAlbums(albums: { id: string; title: string; seededFrom?: string }[]) {
    return this.post('/admin/albums/ensure', { albums });
  }

  async health(): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${this.cfg.apiUrl}/admin/health`, {
        headers: { authorization: `Bearer ${this.cfg.adminToken}` },
      });
      return res.ok ? { ok: true } : { ok: false, error: `${res.status} ${res.statusText}` };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  }
}
