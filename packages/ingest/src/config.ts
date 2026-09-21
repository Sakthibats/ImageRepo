import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  apiUrl: string;       // Worker admin base, e.g. https://api.photos.example.com
  adminToken: string;   // shared secret checked by the Worker itself
  // Cloudflare Access sits in FRONT of the Worker, so a request without these
  // is bounced to a login page and never reaches our code. A service token is
  // how a script authenticates to Access.
  accessClientId: string;
  accessClientSecret: string;
}

/** Loads .env.ingest from the repo root, then overlays real env vars. */
function loadDotEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

export function loadConfig(): Config {
  const file = loadDotEnv(resolve(process.cwd(), '.env.ingest'));
  const get = (k: string) => process.env[k] ?? file[k] ?? '';

  const cfg: Config = {
    accountId: get('CF_ACCOUNT_ID'),
    bucket: get('R2_BUCKET') || 'imagerepo',
    accessKeyId: get('R2_ACCESS_KEY_ID'),
    secretAccessKey: get('R2_SECRET_ACCESS_KEY'),
    apiUrl: get('ADMIN_API_URL').replace(/\/$/, ''),
    adminToken: get('ADMIN_TOKEN'),
    accessClientId: get('CF_ACCESS_CLIENT_ID'),
    accessClientSecret: get('CF_ACCESS_CLIENT_SECRET'),
  };

  const missing = (['accountId', 'accessKeyId', 'secretAccessKey'] as const)
    .filter((k) => !cfg[k]);
  if (missing.length) {
    throw new Error(
      `Missing config: ${missing.join(', ')}.\n` +
      `Create .env.ingest in the repo root (see .env.ingest.example).`
    );
  }
  return cfg;
}

export const r2Endpoint = (accountId: string) =>
  `https://${accountId}.r2.cloudflarestorage.com`;
