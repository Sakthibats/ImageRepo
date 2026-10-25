import type { Env } from './types.js';

/**
 * Share links: unguessable, revocable, read-only, optionally passcoded and
 * expiring, with no login for the viewer.
 *
 * Two separate credentials are involved, deliberately:
 *
 *  1. The share TOKEN in the URL. Long-lived, revocable, stored only as a
 *     sha256 hash so a database dump exposes no live link.
 *  2. Per-asset HMAC tags handed out with each page. These authorise one
 *     media id within one album, are stateless to verify, and are bucketed by
 *     the hour so every viewer of a link shares the same URLs — and therefore
 *     the same edge cache entries. Per-session tokens would give a 0% cache
 *     hit rate.
 *
 * The tag alone is not the gate, though: every asset request also checks D1
 * that the link is live and the item is within what the link shares. So
 * revoking a link, or taking a folder out of it, applies to assets at once;
 * only images already in a guest's browser cache outlive it.
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

/**
 * Signs tags authorising media ids under one share, for one time bucket. The
 * key is imported once, so a page of tags costs one import, not one per item.
 */
export async function assetTagger(
  env: Env, shareId: string, bucket = currentBucket(),
): Promise<(mediaId: string) => Promise<string>> {
  const key = await hmacKey(requireKey(env));
  return async (mediaId) => {
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${shareId}.${mediaId}.${bucket}`));
    return b64url(new Uint8Array(sig)).slice(0, TAG_LENGTH);
  };
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
    const expected = await (await assetTagger(env, shareId, bucket))(mediaId);
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
  scope: 'all' | 'folders'; include_loose: number;
}

// --------------------------------------------------------------------- scope

/**
 * True for an album_media row `am` that share link `s` shows: everything for
 * an 'all' link, otherwise its folders and, if it says so, the loose photos.
 * Guest pages, folder covers and the asset route all use this one definition.
 */
export const IN_SCOPE = `(
  s.scope = 'all'
  OR (am.folder_id IS NULL AND s.include_loose = 1)
  OR am.folder_id IN (SELECT sf.folder_id FROM share_folders sf WHERE sf.token_hash = s.token_hash)
)`;

/** True for a folders row `f` whose name a guest of link `s` may see. */
export const FOLDER_IN_SCOPE = `(
  s.scope = 'all'
  OR f.id IN (SELECT sf.folder_id FROM share_folders sf WHERE sf.token_hash = s.token_hash)
)`;

export interface ShareScope { scope: 'all' | 'folders'; folderIds: string[]; includeLoose: boolean }

/**
 * Reads the scope fields of a create or edit request. Folder ids must belong
 * to the album; a link limited to folders must show something.
 */
export async function readScope(
  db: D1Database, albumId: string,
  b: { scope?: string; folderIds?: unknown; includeLoose?: unknown },
): Promise<ShareScope | { error: string }> {
  if (b.scope === undefined || b.scope === 'all') return { scope: 'all', folderIds: [], includeLoose: true };
  if (b.scope !== 'folders') return { error: "scope must be 'all' or 'folders'" };

  const asked = Array.isArray(b.folderIds) ? [...new Set(b.folderIds.map(String))] : [];
  if (asked.length > 90) return { error: 'too many folders' };
  const includeLoose = b.includeLoose === true;
  if (!asked.length && !includeLoose) return { error: 'choose at least one folder, or the loose photos' };

  if (asked.length) {
    const { results } = await db.prepare(
      `SELECT id FROM folders WHERE album_id = ?1 AND id IN (${asked.map((_, i) => `?${i + 2}`).join(',')})`
    ).bind(albumId, ...asked).all<{ id: string }>();
    if (results.length !== asked.length) return { error: 'a chosen folder is not in this album' };
  }
  return { scope: 'folders', folderIds: asked, includeLoose };
}

/** Statements that make a link's stored scope match `scope`. */
export function writeScope(db: D1Database, tokenHash: string, scope: ShareScope): D1PreparedStatement[] {
  const add = db.prepare('INSERT INTO share_folders (token_hash, folder_id) VALUES (?1, ?2)');
  return [
    db.prepare('UPDATE share_links SET scope = ?2, include_loose = ?3 WHERE token_hash = ?1')
      .bind(tokenHash, scope.scope, scope.includeLoose ? 1 : 0),
    db.prepare('DELETE FROM share_folders WHERE token_hash = ?1').bind(tokenHash),
    ...scope.folderIds.map((f) => add.bind(tokenHash, f)),
  ];
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
