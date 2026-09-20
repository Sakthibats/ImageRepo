-- ImageRepo / D1 schema
-- Apply:  npx wrangler d1 execute imagerepo --file=./schema.sql --remote

-- ---------------------------------------------------------------- media
-- One row per distinct file. id = first 32 hex chars of sha256(file bytes),
-- so re-uploading the same file is a no-op and every URL is immutable.
CREATE TABLE IF NOT EXISTS media (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('photo','video')),
  ext           TEXT NOT NULL,
  bytes         INTEGER NOT NULL,
  width         INTEGER,
  height        INTEGER,
  duration_ms   INTEGER,              -- video only

  taken_at      INTEGER,              -- epoch seconds, EXIF DateTimeOriginal
  uploaded_at   INTEGER NOT NULL,

  -- camera metadata (kept for filtering; harmless to expose)
  camera        TEXT,
  lens          TEXT,
  iso           INTEGER,
  fstop         REAL,
  focal_mm      REAL,

  -- location: STAYS SERVER-SIDE. Never emitted into a guest manifest.
  lat           REAL,
  lon           REAL,
  place         TEXT,                 -- reverse-geocoded, e.g. "Goa, India"

  thumbhash     TEXT,                 -- ~28 byte LQIP placeholder
  caption       TEXT,
  orig_name     TEXT,                 -- original filename, for reference
  source_path   TEXT                  -- path on the laptop at ingest time
);

CREATE INDEX IF NOT EXISTS idx_media_taken   ON media(taken_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_place   ON media(place);
CREATE INDEX IF NOT EXISTS idx_media_kind    ON media(kind);

-- ---------------------------------------------------------------- albums
CREATE TABLE IF NOT EXISTS albums (
  id            TEXT PRIMARY KEY,     -- slug, e.g. "goa-2023"
  title         TEXT NOT NULL,
  description   TEXT,
  cover_id      TEXT REFERENCES media(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  seeded_from   TEXT,                 -- laptop folder this came from
  manifest_ver  TEXT                  -- cache-busting token for the baked JSON
);

-- Many-to-many from day one. A photo can live in several albums.
CREATE TABLE IF NOT EXISTS album_media (
  album_id      TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  media_id      TEXT NOT NULL REFERENCES media(id)  ON DELETE CASCADE,
  position      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (album_id, media_id)
);

CREATE INDEX IF NOT EXISTS idx_am_album ON album_media(album_id, position);
CREATE INDEX IF NOT EXISTS idx_am_media ON album_media(media_id);

-- ---------------------------------------------------------- share links
-- We store ONLY sha256(token). A dump of this table exposes no live link.
CREATE TABLE IF NOT EXISTS share_links (
  token_hash     TEXT PRIMARY KEY,
  album_id       TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  label          TEXT,                -- "sent to mum", for your own reference
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER,             -- NULL = no expiry
  passcode_hash  TEXT,                -- NULL = no passcode (PBKDF2)
  passcode_salt  TEXT,
  allow_download INTEGER NOT NULL DEFAULT 1,
  revoked        INTEGER NOT NULL DEFAULT 0,
  view_count     INTEGER NOT NULL DEFAULT 0,
  last_seen_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_share_album ON share_links(album_id);

-- ------------------------------------------------------------ ingest log
-- Lets the CLI ask "what do you already have?" and makes reconcile possible.
CREATE TABLE IF NOT EXISTS ingest_log (
  media_id     TEXT PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
  derivatives  TEXT NOT NULL,         -- JSON array of generated variants
  ingested_at  INTEGER NOT NULL,
  cli_version  TEXT
);
