-- What a share link shows. 'all' is the whole album, including folders made
-- after the link. 'folders' is only the folders listed in share_folders, plus
-- the photos in no folder when include_loose is set; a folder made later
-- stays private until it is added. Links made before this are 'all'.
ALTER TABLE share_links ADD COLUMN scope TEXT NOT NULL DEFAULT 'all'
  CHECK (scope IN ('all', 'folders'));
ALTER TABLE share_links ADD COLUMN include_loose INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS share_folders (
  token_hash  TEXT NOT NULL REFERENCES share_links(token_hash) ON DELETE CASCADE,
  folder_id   TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  PRIMARY KEY (token_hash, folder_id)
);

CREATE INDEX IF NOT EXISTS idx_share_folders_folder ON share_folders(folder_id);
