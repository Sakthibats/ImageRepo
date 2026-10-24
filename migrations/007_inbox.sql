-- Browser uploads on their way in. The browser puts the raw file at
-- inbox/{id}.{ext} in R2 with a presigned URL; the processing service claims
-- it from here, writes the stripped original and derivatives, and only then
-- is a media row created. Until that point nothing in an album refers to it,
-- so a half-processed file can never appear in a manifest.
--
-- A row is deleted once its media row exists: from then on media is the record.
CREATE TABLE IF NOT EXISTS uploads (
  id            TEXT PRIMARY KEY,         -- content hash, as the browser computed it; the service re-checks
  kind          TEXT NOT NULL CHECK (kind IN ('photo','video')),
  ext           TEXT NOT NULL,
  bytes         INTEGER NOT NULL,
  orig_name     TEXT NOT NULL,
  last_modified INTEGER,                  -- epoch seconds, from the browser's File; a fallback date
  album_id      TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  folder_id     TEXT REFERENCES folders(id) ON DELETE SET NULL,
  -- 'uploading': bytes still going up. 'ready': in the inbox, waiting.
  -- 'claimed': a service holds it until lease_until. 'failed': given up on.
  state         TEXT NOT NULL CHECK (state IN ('uploading','ready','claimed','failed')),
  multipart_id  TEXT,                     -- R2 multipart upload id, for large files
  part_size     INTEGER,
  attempts      INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  runner        TEXT,
  lease_until   INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_uploads_state ON uploads(state, created_at);
