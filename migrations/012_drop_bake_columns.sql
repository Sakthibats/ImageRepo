-- Columns only baking used, which 011 replaced with live reads. No deployed
-- code reads or writes either: manifest_ver named an album's current baked
-- JSON, and position was a default order nothing has sorted by since
-- album_media.sort_ts. 011 already dropped position's index, which SQLite
-- requires before the column can go.
ALTER TABLE albums DROP COLUMN manifest_ver;
ALTER TABLE album_media DROP COLUMN position;
