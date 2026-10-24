import type { MediaRecord } from '@imagerepo/shared';
import type { Config } from './config.js';

/**
 * Posts metadata to the Worker, which owns all D1 writes. The CLI never talks
 * to the database directly — one writer keeps the schema in one place.
 */
export class AdminApi {
  constructor(private cfg: Config) {}

  get configured() { return Boolean(this.cfg.apiUrl && this.cfg.adminToken); }

  /** Access service-token headers, plus our own bearer token for the Worker. */
  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = {
      authorization: `Bearer ${this.cfg.adminToken}`,
      ...extra,
    };
    if (this.cfg.accessClientId && this.cfg.accessClientSecret) {
      h['CF-Access-Client-Id'] = this.cfg.accessClientId;
      h['CF-Access-Client-Secret'] = this.cfg.accessClientSecret;
    }
    return h;
  }

  private async post(path: string, body: unknown) {
    const res = await fetch(`${this.cfg.apiUrl}${path}`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
      redirect: 'manual',           // an Access login redirect is a failure, not a hop
    });
    if (res.status === 302 || res.status === 301) {
      throw new Error(
        `${path} -> blocked by Cloudflare Access.\n` +
        `  Set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET in .env.ingest,\n` +
        `  and add a Service Auth policy for that token on the Access application.`
      );
    }
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

  createShare(opts: {
    albumId: string; label?: string; expiresInDays?: number;
    passcode?: string; allowDownload?: boolean;
  }) {
    return this.post('/admin/shares', opts) as Promise<{
      url: string; token: string; tokenHash: string;
      expiresAt: number | null; hasPasscode: boolean; allowDownload: boolean;
    }>;
  }

  revokeShare(tokenHash: string) {
    return this.post(`/admin/shares/${tokenHash}/revoke`, {});
  }

  async listShares() {
    const res = await fetch(`${this.cfg.apiUrl}/admin/shares`, {
      headers: this.headers(), redirect: 'manual',
    });
    if (!res.ok) throw new Error(`/admin/shares -> ${res.status}`);
    return res.json() as Promise<{ shares: any[] }>;
  }

  async listAlbums() {
    const res = await fetch(`${this.cfg.apiUrl}/admin/albums`, {
      headers: this.headers(), redirect: 'manual',
    });
    if (!res.ok) throw new Error(`/admin/albums -> ${res.status}`);
    return res.json() as Promise<{ albums: any[] }>;
  }

  /** How far each processing stage has got across the whole library. */
  async stageSummary() {
    const res = await fetch(`${this.cfg.apiUrl}/admin/stages/summary`, {
      headers: this.headers(), redirect: 'manual',
    });
    if (res.status === 404) throw new Error('this Worker is older than the CLI — deploy it to see stage progress');
    if (!res.ok) throw new Error(`/admin/stages/summary -> ${res.status}`);
    return res.json() as Promise<{
      media: { kind: string; n: number }[];
      stages: { stage: string; version: number; state: string; n: number }[];
    }>;
  }

  bake(album?: string) {
    return this.post('/admin/bake', album ? { album } : {});
  }

  /** `epoch` changes whenever the library is purged; null from a Worker that predates it. */
  async health(): Promise<{ ok: boolean; error?: string; epoch?: string | null }> {
    try {
      const res = await fetch(`${this.cfg.apiUrl}/admin/health`, {
        headers: this.headers(),
        redirect: 'manual',
      });
      if (res.status === 302 || res.status === 301) {
        return { ok: false, error: 'blocked by Access — set CF_ACCESS_CLIENT_ID/SECRET' };
      }
      if (!res.ok) return { ok: false, error: `${res.status} ${res.statusText}` };
      const body = await res.json().catch(() => ({})) as { epoch?: string | null };
      return { ok: true, epoch: body.epoch ?? null };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  }
}
