// Shared contract between the web app, the Worker and (by mirror) Preprocessing/.

/** Derivative widths we generate. 320 = grid thumb, 1024 = tablet, 2048 = lightbox. */
export const PHOTO_WIDTHS = [320, 1024, 2048] as const;
export type PhotoWidth = (typeof PHOTO_WIDTHS)[number];

/** Poster frames reuse the photo pipeline, so the same widths apply. */
export const VIDEO_PREVIEW_HEIGHT = 720;

export type MediaKind = 'photo' | 'video';

/**
 * Every file type the library takes, by lowercase extension. Each one has a
 * metadata stripper (photos) or is remuxed by ffmpeg (video); anything else
 * would carry its location through untouched, so it is refused.
 */
export const MEDIA_EXT: Record<string, MediaKind> = {
  jpg: 'photo', jpeg: 'photo', png: 'photo', heic: 'photo', heif: 'photo',
  mp4: 'video', mov: 'video', m4v: 'video',
};

/** What the processing service sends to /admin/inbox/complete, one per file. */
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
  /** Variants actually written, e.g. ['320','1024','2048','poster','preview']. */
  derivatives: string[];

  /** Everything the camera wrote, before stripping. Server-side only, like lat/lon. */
  rawMeta?: Record<string, unknown>;
  /** Processing stages completed for this media, and at which version. */
  stages?: StageRef[];
}

/** A processing stage at a specific version, e.g. { name: 'derivatives', version: 1 }. */
export interface StageRef {
  name: string;
  version: number;
}

/** R2 key layout. Content-addressed, so every key is immutable and cacheable forever. */
export const r2Key = {
  original: (id: string, ext: string) => `orig/${id}.${ext}`,
  /**
   * A browser upload, as sent: metadata (and location) intact. Never served;
   * the processing service strips it into orig/ and deletes this.
   */
  inbox: (id: string, ext: string) => `inbox/${id}.${ext}`,
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
  f?: string;                 // folder id; absent = loose in the album
  // NOTE: no lat/lon/place here. Owner manifests add them via OwnerManifestItem.
}

/** A folder inside an album, as the app lists it. */
export interface FolderSummary {
  id: string;
  title: string;
  n: number;
  /** The chosen cover, or the earliest photo in the folder. */
  cover: string | null;
  /** True when the owner picked the cover rather than it being worked out. */
  coverPinned?: boolean;
  newest: number | null;      // taken_at of the most recent item, for ordering
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
  /** Most recent first. Absent from albums baked before folders existed. */
  folders?: FolderSummary[];
}
