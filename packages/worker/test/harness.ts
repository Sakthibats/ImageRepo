// A Worker environment in plain Node: D1 is SQLite in memory with the real
// schema and every migration, R2 is a Map, and Access is a key pair minted
// here, so requests can carry a properly signed JWT.
import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import app from '../src/index.js';
import { insertMedia } from '../src/db.js';
import type { MediaRecord } from '@imagerepo/shared';
import type { Env } from '../src/types.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

let failures = 0;
export const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};
export const finish = () => {
  console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
  process.exit(failures ? 1 : 0);
};

// ------------------------------------------------------------------- D1

/**
 * D1 numbers its parameters (?1, ?2, and ?1 again); better-sqlite3 only takes
 * plain positional ones. Rewrite each mark as `?` and lay the values out in
 * the order the marks appear.
 */
function positional(sql: string, args: unknown[]): { sql: string; args: unknown[] } {
  const out: unknown[] = [];
  let next = 0;
  const text = sql.replace(/\?(\d*)/g, (_, n: string) => {
    const v = args[n ? Number(n) - 1 : next++];
    if (v === undefined) throw new Error(`D1_TYPE_ERROR: undefined bound in: ${sql.trim().slice(0, 80)}`);
    out.push(typeof v === 'boolean' ? Number(v) : v);
    return '?';
  });
  return { sql: text, args: out };
}

class Stmt {
  constructor(private db: Database.Database, private sql: string, private args: unknown[] = []) {}
  bind(...args: unknown[]) { return new Stmt(this.db, this.sql, args); }

  private prepared() {
    const p = positional(this.sql, this.args);
    return { s: this.db.prepare(p.sql), args: p.args };
  }

  exec() {
    const { s, args } = this.prepared();
    if (s.reader) return { results: s.all(...args), success: true, meta: { changes: 0 } };
    const r = s.run(...args);
    return { results: [], success: true, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
  }
  async all() { return this.exec(); }
  async run() { return this.exec(); }
  async first(col?: string) {
    const row = this.exec().results[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return col ? row[col] : row;
  }
}

export function makeD1() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');            // D1 enforces them
  db.exec(readFileSync(join(ROOT, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  }
  const d1 = {
    prepare: (sql: string) => new Stmt(db, sql),
    batch: async (stmts: Stmt[]) => db.transaction(() => stmts.map((s) => s.exec()))(),
    exec: async (sql: string) => { db.exec(sql); return { count: 0, duration: 0 }; },
  };
  return { d1, sqlite: db };
}

// ------------------------------------------------------------------- R2

export class FakeR2 {
  objects = new Map<string, Uint8Array>();
  /** Calls made, to check a request stays inside Worker limits. */
  calls = 0;

  async put(key: string, value: string | ArrayBuffer | Uint8Array) {
    this.calls++;
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value)
      : value instanceof Uint8Array ? value : new Uint8Array(value);
    this.objects.set(key, bytes);
    return { key, size: bytes.length };
  }
  async get(key: string) {
    this.calls++;
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    return {
      key, size: bytes.length, httpEtag: `"${bytes.length}"`,
      body: new Blob([bytes]).stream(),
      text: async () => new TextDecoder().decode(bytes),
      json: async () => JSON.parse(new TextDecoder().decode(bytes)),
    };
  }
  async head(key: string) {
    this.calls++;
    const bytes = this.objects.get(key);
    return bytes ? { key, size: bytes.length } : null;
  }
  async delete(keys: string | string[]) {
    this.calls++;
    const list = Array.isArray(keys) ? keys : [keys];
    if (list.length > 1000) throw new Error('R2 delete takes at most 1000 keys');
    for (const k of list) this.objects.delete(k);
  }
  async list(o: { prefix?: string; cursor?: string; limit?: number } = {}) {
    this.calls++;
    const limit = o.limit ?? 1000;
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(o.prefix ?? '')).sort()
      .filter((k) => !o.cursor || k > o.cursor);
    const page = keys.slice(0, limit);
    const truncated = keys.length > limit;
    return {
      objects: page.map((key) => ({ key, size: this.objects.get(key)!.length })),
      truncated, cursor: truncated ? page[page.length - 1] : undefined,
    };
  }
  keys(prefix = '') { return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort(); }
}

// --------------------------------------------------------------- Access

const TEAM = 'testteam';
const AUD = 'test-aud';
const KID = 'test-key';

const pair = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true, ['sign', 'verify'],
);
const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);

// ------------------------------------------------------------ R2 S3 API

export const R2_ACCOUNT = 'testacct';
const S3_BASE = `https://${R2_ACCOUNT}.r2.cloudflarestorage.com/imagerepo/`;

/**
 * Enough of R2's S3 API for presigned uploads: a PUT (the browser's, with a
 * presigned URL) and the multipart calls the Worker makes itself. Objects
 * land in whichever FakeR2 the test is using, set through `s3Bucket`.
 */
export const s3State = {
  bucket: null as FakeR2 | null,
  multipart: new Map<string, { key: string; parts: Map<number, Uint8Array> }>(),
  /** Every S3 request, as "METHOD key?query", to check what the Worker did. */
  log: [] as string[],
};

async function fakeS3(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const key = decodeURIComponent(url.pathname.replace(/^\/imagerepo\//, ''));
  const q = url.searchParams;
  s3State.log.push(`${req.method} ${key}${url.search ? '?' + [...q.keys()].join('&') : ''}`);
  const signed = q.has('X-Amz-Signature') || (req.headers.get('authorization') ?? '').startsWith('AWS4-HMAC-SHA256');
  if (!signed) return new Response('unsigned', { status: 403 });
  const bucket = s3State.bucket!;
  const uploadId = q.get('uploadId');

  if (req.method === 'POST' && q.has('uploads')) {
    const id = `mp-${s3State.multipart.size + 1}`;
    s3State.multipart.set(id, { key, parts: new Map() });
    return new Response(`<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
  }
  if (uploadId) {
    const mp = s3State.multipart.get(uploadId);
    if (!mp || mp.key !== key) return new Response('NoSuchUpload', { status: 404 });
    if (req.method === 'PUT') {
      mp.parts.set(Number(q.get('partNumber')), new Uint8Array(await req.arrayBuffer()));
      return new Response('', { headers: { etag: `"etag-${q.get('partNumber')}"` } });
    }
    if (req.method === 'GET') {
      const parts = [...mp.parts].sort(([a], [b]) => a - b).map(([n, b]) =>
        `<Part><PartNumber>${n}</PartNumber><ETag>&quot;etag-${n}&quot;</ETag><Size>${b.length}</Size></Part>`);
      return new Response(`<ListPartsResult>${parts.join('')}</ListPartsResult>`);
    }
    if (req.method === 'POST') {
      const body = await req.text();
      const nums = [...body.matchAll(/<PartNumber>(\d+)<\/PartNumber><ETag>"etag-(\d+)"<\/ETag>/g)]
        .map((m) => Number(m[1]));
      const chunks = nums.map((n) => mp.parts.get(n)!);
      const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let at = 0;
      for (const c of chunks) { all.set(c, at); at += c.length; }
      await bucket.put(key, all);
      s3State.multipart.delete(uploadId);
      return new Response('<CompleteMultipartUploadResult/>');
    }
    if (req.method === 'DELETE') { s3State.multipart.delete(uploadId); return new Response(null, { status: 204 }); }
  }
  if (req.method === 'PUT') {
    await bucket.put(key, new Uint8Array(await req.arrayBuffer()));
    return new Response('', { headers: { etag: '"x"' } });
  }
  return new Response('unsupported', { status: 400 });
}

// The Worker fetches Access's signing keys; answer with ours. R2's S3 API is
// faked above.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url === `https://${TEAM}.cloudflareaccess.com/cdn-cgi/access/certs`) {
    return new Response(JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: 'RS256', use: 'sig' }] }));
  }
  if (url.startsWith(S3_BASE)) return fakeS3(input instanceof Request ? input : new Request(url, init));
  return realFetch(input, init);
}) as typeof fetch;

const b64url = (bytes: Uint8Array) =>
  Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

/** A signed Access JWT. A person has an email; a service token a common_name. */
export async function accessJwt(claims: Record<string, unknown>): Promise<string> {
  const body = `${enc({ alg: 'RS256', kid: KID })}.${enc({
    aud: [AUD], iss: `https://${TEAM}.cloudflareaccess.com`,
    exp: Math.floor(Date.now() / 1000) + 600, ...claims,
  })}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(body));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

// ------------------------------------------------------------------ app

export const ADMIN_TOKEN = 'test-admin-token';

export const PREPROCESS_CLIENT_ID = 'preprocess.access';

export function makeWorld(o: { s3?: boolean } = {}) {
  const { d1, sqlite } = makeD1();
  const bucket = new FakeR2();
  s3State.bucket = bucket;
  const s3 = o.s3 === false ? {} : {
    R2_ACCOUNT_ID: R2_ACCOUNT, R2_BUCKET_NAME: 'imagerepo',
    R2_ACCESS_KEY_ID: 'test-key-id', R2_SECRET_ACCESS_KEY: 'test-secret',
  };
  const env = {
    DB: d1, BUCKET: bucket, ADMIN_TOKEN, SHARE_HMAC_KEY: 'test-hmac-key',
    ACCESS_TEAM: TEAM, ACCESS_AUD: AUD, PREPROCESS_CLIENT_ID, ...s3,
    ASSETS: { fetch: async () => new Response('<!doctype html>') },
  } as unknown as Env;
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} };

  /** A jwt with `token` too is a service-token JWT plus the ADMIN_TOKEN bearer. */
  type Auth = 'token' | 'none' | { jwt: string; token?: boolean };
  async function call(method: string, path: string, o: { body?: unknown; auth?: Auth; cookie?: string } = {}) {
    const headers: Record<string, string> = {};
    const auth = o.auth ?? 'token';
    if (auth === 'token') headers.authorization = `Bearer ${ADMIN_TOKEN}`;
    else if (auth !== 'none') {
      headers['cf-access-jwt-assertion'] = auth.jwt;
      if (auth.token) headers.authorization = `Bearer ${ADMIN_TOKEN}`;
    }
    if (o.cookie) headers.cookie = o.cookie;
    if (o.body !== undefined) headers['content-type'] = 'application/json';
    const res = await app.request(`http://test${path}`, {
      method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body),
    }, env, ctx as any);
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, headers: res.headers };
  }

  return { env, sqlite, bucket, call };
}

/**
 * Processed media, recorded as /admin/inbox/complete records it, with any
 * albums it names created first.
 */
export async function addMedia(world: ReturnType<typeof makeWorld>, records: Partial<MediaRecord>[]) {
  const album = world.sqlite.prepare(
    `INSERT INTO albums (id, title, created_at, updated_at) VALUES (?, ?, 0, 0) ON CONFLICT(id) DO NOTHING`);
  for (const a of new Set(records.flatMap((r) => r.albums ?? []))) album.run(a, a);
  for (let i = 0; i < records.length; i += 200) {
    await insertMedia(world.env.DB, records.slice(i, i + 200) as MediaRecord[]);
  }
}

/**
 * Where the counts and sort dates that triggers keep (migration 011) disagree
 * with the rows they summarise. Empty when everything is in step.
 */
export function drift(world: ReturnType<typeof makeWorld>): string[] {
  const rows = (sql: string) => (world.sqlite.prepare(sql).all() as { d: string }[]).map((r) => r.d);
  return [
    ...rows(`SELECT 'album ' || id || ' counts ' || item_count AS d FROM albums
             WHERE item_count <> (SELECT COUNT(*) FROM album_media WHERE album_id = albums.id)`),
    ...rows(`SELECT 'folder ' || id || ' counts ' || item_count AS d FROM folders
             WHERE item_count <> (SELECT COUNT(*) FROM album_media WHERE folder_id = folders.id)`),
    ...rows(`SELECT 'link ' || am.media_id || ' sorts at ' || IFNULL(am.sort_ts, 'null') AS d
             FROM album_media am JOIN media m ON m.id = am.media_id WHERE am.sort_ts IS NOT m.sort_ts`),
  ];
}

/** n photos in an album, with their objects in R2, and the album baked. */
export async function seedMedia(
  world: ReturnType<typeof makeWorld>, n: number, album: string, start = 0,
): Promise<string[]> {
  const ids: string[] = [];
  const records = [];
  for (let i = start; i < start + n; i++) {
    const id = i.toString(16).padStart(32, '0');
    ids.push(id);
    records.push({
      id, kind: 'photo', ext: 'jpg', bytes: 1000, width: 400, height: 300,
      takenAt: 1_700_000_000 + i * 60, lat: 15.49, lon: 73.82, place: 'Goa',
      origName: `IMG_${i}.jpg`, albums: [album], derivatives: ['320', '1024', '2048'],
    });
    await world.bucket.put(`orig/${id}.jpg`, 'o');
    for (const w of [320, 1024, 2048]) await world.bucket.put(`drv/${id}/${w}.avif`, 'd');
  }
  await addMedia(world, records);
  const baked = await world.call('POST', '/admin/bake', { body: { album } });
  if (baked.status !== 200) throw new Error(`bake failed: ${baked.status}`);
  return ids;
}
