// Shared contract between the web app, the Worker and (by mirror) Preprocessing/.

/** Derivative widths we generate. 320 = grid thumb, 1024 = tablet, 2048 = lightbox. */
export const PHOTO_WIDTHS = [320, 1024, 2048] as const;
export type PhotoWidth = (typeof PHOTO_WIDTHS)[number];

/**
 * The sizes made for a photo, or a video's poster, `width` pixels wide as
 * displayed. Never upscaled, so only the sizes it covers, but always the
 * smallest, which is the grid thumbnail. Preprocessing/images.py makes these.
 */
export const widthsMade = (width: number): PhotoWidth[] =>
  PHOTO_WIDTHS.filter((w, i) => i === 0 || w <= width);

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

  // Location never reaches a guest. Server-side only.
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
};

/** One photo or video in a listing. Deliberately terse: pages of these ship to browsers. */
export interface MediaItem {
  id: string;
  k: MediaKind;
  w: number;
  h: number;
  t?: number;                 // takenAt
  th?: string;                // thumbhash
  d?: number;                 // durationMs, video only
  c?: string;                 // caption
  f?: string;                 // folder id; absent = loose in the album
  r?: number;                 // revision of its served files, in their URLs; absent = 0
  // NOTE: no lat/lon/place here. The owner's listings add them via OwnerMediaItem.
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
  /** The cover's revision, for its URL; absent = 0. */
  coverRev?: number;
  /** Guests only: the tag that lets them load the cover, which may not be on a page they have yet. */
  coverTag?: string;
  newest: number | null;      // sort date of the most recent item, for ordering
}

/** The owner's listings add location. Never serialized for share links. */
export interface OwnerMediaItem extends MediaItem {
  lat?: number;
  lon?: number;
  place?: string;
}

/** One page of a listing, in date order. `next` asks for the page after it. */
export interface MediaPage<T extends MediaItem = MediaItem> {
  items: T[];
  next: string | null;
}

/** An album as the album list shows it. */
export interface AlbumSummary {
  id: string;
  title: string;
  n: number;
  /** The chosen cover, or the album's earliest photo. */
  cover: string | null;
  /** The cover's revision, for its URL; absent = 0. */
  coverRev?: number;
  newest: number | null;      // sort date of the most recent item, for ordering
}

/** An open album: its folders, and how many photos sit in none. */
export interface AlbumDetail extends AlbumSummary {
  loose: number;
  folders: FolderSummary[];
}
