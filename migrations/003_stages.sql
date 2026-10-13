-- Processing is a list of named, versioned stages (exif, original,
-- derivatives, ...). Recording which stage ran at which version per media
-- makes "what still needs doing?" a query: adding a stage, or bumping one's
-- version, turns the whole library into its backlog with no separate queue.
CREATE TABLE IF NOT EXISTS media_stages (
  media_id    TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  stage       TEXT NOT NULL,
  version     INTEGER NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('done','failed')),
  attempts    INTEGER NOT NULL DEFAULT 1,
  error       TEXT,
  runner      TEXT,                      -- who did it, e.g. "cli"
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (media_id, stage)
);

CREATE INDEX IF NOT EXISTS idx_media_stages_stage ON media_stages(stage, version, state);

-- Everything the camera wrote, as JSON. Originals in R2 are stripped, so this
-- is the only copy a later stage can read. Contains GPS: owner-side only,
-- never selected into a manifest.
ALTER TABLE media ADD COLUMN raw_meta TEXT;
