import type { Env } from './types.js';

/**
 * Share links: unguessable, revocable, read-only, optionally passcoded and
 * expiring, with no login for the viewer.
 *
 * Two separate credentials are involved, deliberately:
 *
 *  1. The share TOKEN in the URL. Long-lived, revocable, stored only as a
 *     sha256 hash so a database dump exposes no live link.
 *  2. Per-asset HMAC tags handed out with the manifest. These authorise one
 *     media id within one album, are stateless to verify, and are bucketed by
 *     the hour so every viewer of a link shares the same URLs — and therefore
 *     the same edge cache entries. Per-session tokens would give a 0% cache
 *     hit rate.
 *
 * Revocation is immediate for the manifest and takes effect for assets within
 * one bucket window. That trade buys the cache reuse above.
 */

const BUCKET_SECONDS = 3600;
const TAG_LENGTH = 22;          // base64url chars of a truncated HMAC

const enc = new TextEncoder();

export function newShareToken(): string {
  const bytes = new Uint8Array(32);          // 256 bits
  crypto.getRandomValues(bytes);
  return b64url(bytes);
}

export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

function currentBucket(at = Date.now()): number {
  return Math.floor(at / 1000 / BUCKET_SECONDS);
}

/** Tag authorising one media id, under one share, for one time bucket. */
export async function assetTag(
  env: Env, shareId: string, mediaId: string, bucket = currentBucket(),
): Promise<string> {
  const key = await hmacKey(requireKey(env));
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${shareId}.${mediaId}.${bucket}`));
  return b64url(new Uint8Array(sig)).slice(0, TAG_LENGTH);
}

/**
 * Accepts the current or previous bucket, so a page loaded at 10:59 keeps
 * working at 11:00 instead of every image breaking on the hour boundary.
 */
export async function verifyAssetTag(
  env: Env, shareId: string, mediaId: string, tag: string,
): Promise<boolean> {
  if (!tag || tag.length !== TAG_LENGTH) return false;
  const now = currentBucket();
  for (const bucket of [now, now - 1]) {
    const expected = await assetTag(env, shareId, mediaId, bucket);
    if (timingSafe(expected, tag)) return true;
  }
  return false;
}

function timingSafe(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function requireKey(env: Env): string {
  const k = env.SHARE_HMAC_KEY;
  if (!k) throw new Error('SHARE_HMAC_KEY is not configured');
  return k;
}

// ----------------------------------------------------------------- passcodes

const PBKDF2_ITERATIONS = 100_000;

export async function hashPasscode(passcode: string, saltB64?: string) {
  const salt = saltB64
    ? Uint8Array.from(atob(saltB64.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
    : crypto.getRandomValues(new Uint8Array(16));
  const base = await crypto.subtle.importKey('raw', enc.encode(passcode), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    base, 256,
  );
  return { hash: b64url(new Uint8Array(bits)), salt: b64url(salt) };
}

export async function verifyPasscode(passcode: string, hash: string, salt: string): Promise<boolean> {
  const got = await hashPasscode(passcode, salt);
  return timingSafe(got.hash, hash);
}

// ------------------------------------------------------------ share session

export interface ShareSession { s: string; a: string; d: boolean; exp: number }

/** Signed, compact session cookie. Proves the passcode step was completed. */
export async function signSession(env: Env, session: ShareSession): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(session)));
  const key = await hmacKey(requireKey(env));
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return `${body}.${b64url(new Uint8Array(sig)).slice(0, 32)}`;
}

export async function verifySession(env: Env, cookie: string): Promise<ShareSession | null> {
  const [body, sig] = cookie.split('.');
  if (!body || !sig) return null;
  const key = await hmacKey(requireKey(env));
  const expected = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  if (!timingSafe(b64url(new Uint8Array(expected)).slice(0, 32), sig)) return null;
  try {
    const s = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/'))) as ShareSession;
    if (!s.exp || s.exp < Math.floor(Date.now() / 1000)) return null;
    return s;
  } catch {
    return null;
  }
}

export interface ShareRow {
  token_hash: string; album_id: string; label: string | null;
  created_at: number; expires_at: number | null;
  passcode_hash: string | null; passcode_salt: string | null;
  allow_download: number; revoked: number; view_count: number;
}

/** Looks a share up by its plaintext token and rejects revoked/expired ones. */
export async function lookupShare(db: D1Database, token: string): Promise<ShareRow | null> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
  const hash = await sha256Hex(token);
  const row = await db.prepare(
    `SELECT * FROM share_links WHERE token_hash = ?1`
  ).bind(hash).first<ShareRow>();
  if (!row) return null;
  if (row.revoked) return null;
  if (row.expires_at && row.expires_at < Math.floor(Date.now() / 1000)) return null;
  return row;
}
