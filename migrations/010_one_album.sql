-- A photo lives in one album. An upload of a file that is in another album is
-- refused, and moving a photo takes it out of the album it was in. The unique
-- index replaces the plain one on the same column.
CREATE UNIQUE INDEX IF NOT EXISTS idx_am_one_album ON album_media(media_id);
DROP INDEX IF EXISTS idx_am_media;
