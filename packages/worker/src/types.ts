export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ADMIN_TOKEN: string;
  SHARE_HMAC_KEY?: string;
  ACCESS_TEAM?: string;
  ACCESS_AUD?: string;
  /** For presigned uploads through R2's S3 API (s3.ts). */
  R2_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  /** The processing service's Access service token Client ID; see auth.ts. */
  PREPROCESS_CLIENT_ID?: string;
  ASSETS: Fetcher;
}

/** Who is making this request, and what may they see? */
export type Viewer =
  | { kind: 'owner' }
  | { kind: 'share'; albumId: string; shareId: string; allowDownload: boolean }
  | { kind: 'none' };
