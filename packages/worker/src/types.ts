export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ADMIN_TOKEN: string;
  SHARE_HMAC_KEY?: string;
  ACCESS_TEAM?: string;
  ACCESS_AUD?: string;
  ASSETS: Fetcher;
}

/** Who is making this request, and what may they see? */
export type Viewer =
  | { kind: 'owner' }
  | { kind: 'share'; albumId: string; shareId: string; allowDownload: boolean }
  | { kind: 'none' };
