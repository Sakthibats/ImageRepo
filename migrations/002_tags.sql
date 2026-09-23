-- Tags are a first-class entity rather than a text column on media, so that
-- renaming a tag is one row, counts are a join, and a tag can carry its own
-- colour later without touching every photo.
CREATE TABLE IF NOT EXISTS tags (
  id          TEXT PRIMARY KEY,          -- slug
  name        TEXT NOT NULL,             -- display form
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS media_tags (
  media_id  TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  tag_id    TEXT NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  added_at  INTEGER NOT NULL,
  PRIMARY KEY (media_id, tag_id)
);

-- The reverse lookup (tag -> photos) is the one the search tab runs.
CREATE INDEX IF NOT EXISTS idx_media_tags_tag ON media_tags(tag_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_name ON tags(LOWER(name));
