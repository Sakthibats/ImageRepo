// Shared contract between the ingest CLI and the Worker.

/** Derivative widths we generate. 320 = grid thumb, 1024 = tablet, 2048 = lightbox. */
export const PHOTO_WIDTHS = [320, 1024, 2048] as const;
export type PhotoWidth = (typeof PHOTO_WIDTHS)[number];

/** Poster frames reuse the photo pipeline, so the same widths apply. */
export const VIDEO_PREVIEW_HEIGHT = 720;

export type MediaKind = 'photo' | 'video';

/** What the CLI POSTs to /admin/ingest — one per file. */
export interface MediaRecord {
  id: string;                 // sha256(file)[0..32]
  kind: MediaKind;
  ext: string;                // 'jpg' | 'mp4'
  bytes: number;
  width?: number;
  height?: number;
  durationMs?: number;

  takenAt?: number;           // epoch seconds
  camera?: string;
  lens?: string;
  iso?: number;
  fstop?: number;
  focalMm?: number;

  // Location never reaches a guest manifest. Server-side only.
  lat?: number;
  lon?: number;
  place?: string;

  thumbhash?: string;
  caption?: string;
  origName: string;
  sourcePath?: string;

  /** Album slugs seeded from the laptop folder structure. */
  albums: string[];
  /** Variants the CLI actually uploaded, e.g. ['320','1024','2048','poster','preview']. */
  derivatives: string[];
}

/** R2 key layout. Content-addressed, so every key is immutable and cacheable forever. */
export const r2Key = {
  original: (id: string, ext: string) => `orig/${id}.${ext}`,
  derivative: (id: string, width: number) => `drv/${id}/${width}.avif`,
  poster: (id: string) => `post/${id}.jpg`,
  videoPreview: (id: string) => `prev/${id}.mp4`,
  albumManifest: (albumId: string, ver: string) => `man/album/${albumId}.${ver}.json`,
  index: (ver: string) => `man/index.${ver}.json`,
};

/** An entry inside a baked album manifest. Deliberately terse — this ships to browsers. */
export interface ManifestItem {
  id: string;
  k: MediaKind;
  w: number;
  h: number;
  t?: number;                 // takenAt
  th?: string;                // thumbhash
  d?: number;                 // durationMs, video only
  c?: string;                 // caption
  // NOTE: no lat/lon/place here. Owner manifests add them via OwnerManifestItem.
}

/** Owner-only manifest adds location. Never serialized for share links. */
export interface OwnerManifestItem extends ManifestItem {
  lat?: number;
  lon?: number;
  place?: string;
}

export interface AlbumManifest {
  album: string;
  title: string;
  ver: string;
  count: number;
  items: ManifestItem[] | OwnerManifestItem[];
}
