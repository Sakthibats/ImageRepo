import { AwsClient } from 'aws4fetch';
import type { Env } from './types.js';

/**
 * R2's S3-compatible API, for what the bucket binding cannot do: presigned
 * URLs, which let a browser send bytes straight to R2 instead of through this
 * Worker (no body-size cap, no Worker time spent relaying), and the multipart
 * calls that go with them.
 *
 * Needs an R2 API token's key pair as Worker secrets. Without them, null.
 */
export interface S3 {
  presignPut(key: string, ttl: number, query?: Record<string, string>): Promise<string>;
  createMultipart(key: string): Promise<string>;
  listParts(key: string, uploadId: string): Promise<{ partNumber: number; etag: string; size: number }[]>;
  completeMultipart(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<void>;
  abortMultipart(key: string, uploadId: string): Promise<void>;
}

export function r2s3(env: Env): S3 | null {
  const account = env.R2_ACCOUNT_ID?.trim();
  if (!account || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) return null;

  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto',
  });
  const base = `https://${account}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME || 'imagerepo'}`;
  const url = (key: string, query: Record<string, string> = {}) => {
    const u = new URL(`${base}/${key}`);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u.toString();
  };

  // Errors name the operation and status only: R2's body can echo the key
  // and the request, and callers must not pass it on to a client.
  async function send(op: string, target: string, init: RequestInit): Promise<Response> {
    const res = await client.fetch(target, init);
    if (!res.ok) throw new Error(`R2 ${op} failed: ${res.status}`);
    return res;
  }

  return {
    async presignPut(key, ttl, query = {}) {
      const signed = await client.sign(url(key, { ...query, 'X-Amz-Expires': String(ttl) }), {
        method: 'PUT',
        aws: { signQuery: true },
      });
      return signed.url;
    },

    async createMultipart(key) {
      const res = await send('create multipart', url(key, { uploads: '' }), { method: 'POST' });
      const id = /<UploadId>([^<]+)<\/UploadId>/.exec(await res.text())?.[1];
      if (!id) throw new Error('R2 create multipart returned no UploadId');
      return id;
    },

    async listParts(key, uploadId) {
      const res = await send('list parts', url(key, { uploadId, 'max-parts': '1000' }), { method: 'GET' });
      const xml = await res.text();
      return [...xml.matchAll(/<Part>([\s\S]*?)<\/Part>/g)].map(([, p]) => ({
        partNumber: Number(/<PartNumber>(\d+)<\/PartNumber>/.exec(p)?.[1]),
        etag: /<ETag>([^<]+)<\/ETag>/.exec(p)?.[1].replace(/&quot;/g, '"') ?? '',
        size: Number(/<Size>(\d+)<\/Size>/.exec(p)?.[1] ?? 0),
      }));
    },

    async completeMultipart(key, uploadId, parts) {
      const body = '<CompleteMultipartUpload>' + parts
        .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`)
        .join('') + '</CompleteMultipartUpload>';
      await send('complete multipart', url(key, { uploadId }), { method: 'POST', body });
    },

    async abortMultipart(key, uploadId) {
      await send('abort multipart', url(key, { uploadId }), { method: 'DELETE' });
    },
  };
}
