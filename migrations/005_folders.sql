-- One level of folders inside an album. Folders cannot hold folders: there is
-- no parent column. Moving a photo between folders changes one row here and
-- re-bakes the album; nothing in R2 moves, since keys are content hashes.
CREATE TABLE IF NOT EXISTS folders (
  id          TEXT PRIMARY KEY,           -- random; titles can be renamed
  album_id    TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  -- NULL = the earliest photo in the folder, worked out at bake time.
  cover_id    TEXT REFERENCES media(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_title ON folders(album_id, LOWER(title));

-- Folder membership belongs to the album membership: the same photo can sit in
-- a folder in one album and loose in another. NULL = loose in the album.
-- Deleting a folder puts its photos back loose.
ALTER TABLE album_media ADD COLUMN folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_am_folder ON album_media(folder_id);
