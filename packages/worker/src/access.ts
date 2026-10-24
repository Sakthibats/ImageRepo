import type { Env, Viewer } from './types.js';

/**
 * Cloudflare Access puts a signed JWT on every request that passes its login
 * flow, in the Cf-Access-Jwt-Assertion header. Access sits in front of the
 * Worker, but we verify the token ourselves rather than trusting the header's
 * presence: a Worker on workers.dev is reachable directly, bypassing Access
 * entirely, so an unverified header is just an attacker-supplied string.
 */

interface Jwk { kid: string; kty: string; alg: string; use: string; n: string; e: string }

const JWKS_TTL_MS = 60 * 60 * 1000;
let jwksCache: { team: string; keys: Map<string, CryptoKey>; at: number } | null = null;

async function getKeys(team: string): Promise<Map<string, CryptoKey>> {
  if (jwksCache && jwksCache.team === team && Date.now() - jwksCache.at < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const res = await fetch(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const { keys } = await res.json<{ keys: Jwk[] }>();

  const map = new Map<string, CryptoKey>();
  for (const jwk of keys) {
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    map.set(jwk.kid, key);
  }
  jwksCache = { team, keys: map, at: Date.now() };
  return map;
}

const b64urlToBytes = (s: string): Uint8Array => {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

export interface AccessClaims {
  aud?: string | string[]; exp?: number; iss?: string;
  email?: string; sub?: string; common_name?: string;
}

/** Returns the verified subject, or null if the assertion is absent or invalid. */
export async function verifyAccessJwt(req: Request, env: Env): Promise<string | null> {
  const claims = await verifiedClaims(req, env);
  return claims ? claims.email ?? claims.sub ?? 'owner' : null;
}

/**
 * The email of the person signed in through Access, or null. Service tokens,
 * which is how the CLI gets past Access, are issued a valid JWT too, but one
 * with no email and a common_name instead. This is what tells someone at a
 * browser apart from a script holding credentials.
 */
export async function accessUserEmail(req: Request, env: Env): Promise<string | null> {
  const claims = await verifiedClaims(req, env);
  if (!claims || claims.common_name) return null;
  return typeof claims.email === 'string' && claims.email ? claims.email : null;
}

export async function verifiedClaims(req: Request, env: Env): Promise<AccessClaims | null> {
  const team = env.ACCESS_TEAM?.trim();
  const aud = env.ACCESS_AUD?.trim();
  if (!team || !aud) return null;               // Access not configured yet

  const token = req.headers.get('cf-access-jwt-assertion')
    ?? /CF_Authorization=([^;]+)/.exec(req.headers.get('cookie') ?? '')?.[1];
  if (!token) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [rawHeader, rawPayload, rawSig] = parts;

  let header: { kid?: string; alg?: string };
  let payload: AccessClaims;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(rawHeader)));
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(rawPayload)));
  } catch {
    return null;
  }

  // Reject anything not signed with the algorithm we expect. Accepting the
  // token's own `alg` is how "alg: none" downgrade attacks get in.
  if (header.alg !== 'RS256' || !header.kid) return null;

  const keys = await getKeys(team);
  const key = keys.get(header.kid);
  if (!key) return null;

  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlToBytes(rawSig),
    new TextEncoder().encode(`${rawHeader}.${rawPayload}`),
  );
  if (!ok) return null;

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) return null;
  if (payload.iss !== `https://${team}.cloudflareaccess.com`) return null;

  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) return null;

  return payload;
}

/** Resolves who is asking. Share-link handling arrives in Phase 5. */
export async function resolveViewer(req: Request, env: Env): Promise<Viewer> {
  const subject = await verifyAccessJwt(req, env);
  if (subject) return { kind: 'owner' };

  // Fallback while Access is not yet configured: the admin bearer token.
  // Lets you browse your own library before the Zero Trust app exists.
  const header = req.headers.get('authorization') ?? '';
  if (header.startsWith('Bearer ') && env.ADMIN_TOKEN) {
    const presented = header.slice(7);
    if (presented.length === env.ADMIN_TOKEN.length && presented === env.ADMIN_TOKEN) {
      return { kind: 'owner' };
    }
  }
  return { kind: 'none' };
}
