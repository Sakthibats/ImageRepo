import { S3Client, PutObjectCommand, HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { Config } from './config.js';
import { r2Endpoint } from './config.js';

const MULTIPART_THRESHOLD = 64 * 1024 * 1024;   // 64MB

export class R2 {
  private client: S3Client;
  constructor(private cfg: Config) {
    this.client = new S3Client({
      region: 'auto',
      endpoint: r2Endpoint(cfg.accountId),
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
    });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
      return true;
    } catch (e: any) {
      if (e?.$metadata?.httpStatusCode === 404 || e?.name === 'NotFound') return false;
      throw e;
    }
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    // Content-addressed keys never change, so everything is safe to cache forever.
    const common = {
      Bucket: this.cfg.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable',
    };

    if (body.length < MULTIPART_THRESHOLD) {
      await this.client.send(new PutObjectCommand(common));
      return;
    }
    const up = new Upload({ client: this.client, params: common, queueSize: 4, partSize: 16 * 1024 * 1024 });
    await up.done();
  }

  /** Cheap connectivity + credential check used by `doctor`. */
  async check(): Promise<{ ok: boolean; objects?: number; error?: string }> {
    try {
      const r = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.cfg.bucket, MaxKeys: 1 })
      );
      return { ok: true, objects: r.KeyCount ?? 0 };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  }
}

export const contentTypeFor = (ext: string): string => ({
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  heic: 'image/heic', heif: 'image/heif',
  mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v',
  avif: 'image/avif',
}[ext.toLowerCase().replace(/^\./, '')] ?? 'application/octet-stream');
