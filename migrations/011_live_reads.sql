-- Albums are read live from D1 a page at a time, no longer from baked JSON in
-- R2. On the free plan every row a query touches counts, so a page has to be
-- an index range, not a sort of the whole album, and an album list has to read
-- its counts from a row rather than count every photo.

-- The date a photo sorts by: when it was taken, or failing that when it
-- arrived. Generated, so nothing has to keep it in step.
ALTER TABLE media ADD COLUMN sort_ts INTEGER GENERATED ALWAYS AS (COALESCE(taken_at, uploaded_at)) VIRTUAL;
CREATE INDEX IF NOT EXISTS idx_media_sort ON media(sort_ts, id);
-- Nothing orders by taken_at alone any more.
DROP INDEX IF EXISTS idx_media_taken;

-- The same date on the album link, so one index pages an album, a folder or
-- the loose photos. Set when a link is made (the INSERTs copy media.sort_ts)
-- and by the trigger below when a photo's date changes.
ALTER TABLE album_media ADD COLUMN sort_ts INTEGER;
UPDATE album_media SET sort_ts = (SELECT sort_ts FROM media WHERE media.id = album_media.media_id);
CREATE INDEX IF NOT EXISTS idx_am_album_sort ON album_media(album_id, sort_ts, media_id);
CREATE INDEX IF NOT EXISTS idx_am_folder_sort ON album_media(album_id, folder_id, sort_ts, media_id);
-- Replaced by idx_am_album_sort. position is no longer written or read.
DROP INDEX IF EXISTS idx_am_album;

CREATE TRIGGER IF NOT EXISTS media_sort_ts
AFTER UPDATE OF taken_at, uploaded_at ON media
WHEN OLD.sort_ts IS NOT NEW.sort_ts
BEGIN
  UPDATE album_media SET sort_ts = NEW.sort_ts WHERE media_id = NEW.id;
END;

-- How many photos and videos each album and folder holds, kept by triggers on
-- album_media. They also fire for the foreign keys' cascades: a deleted photo,
-- or a deleted folder setting its photos loose.
ALTER TABLE albums ADD COLUMN item_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE folders ADD COLUMN item_count INTEGER NOT NULL DEFAULT 0;
UPDATE albums SET item_count = (SELECT COUNT(*) FROM album_media WHERE album_id = albums.id);
UPDATE folders SET item_count = (SELECT COUNT(*) FROM album_media WHERE folder_id = folders.id);

CREATE TRIGGER IF NOT EXISTS album_media_added
AFTER INSERT ON album_media
BEGIN
  UPDATE albums SET item_count = item_count + 1 WHERE id = NEW.album_id;
  UPDATE folders SET item_count = item_count + 1 WHERE id = NEW.folder_id;
END;

CREATE TRIGGER IF NOT EXISTS album_media_removed
AFTER DELETE ON album_media
BEGIN
  UPDATE albums SET item_count = item_count - 1 WHERE id = OLD.album_id;
  UPDATE folders SET item_count = item_count - 1 WHERE id = OLD.folder_id;
END;

CREATE TRIGGER IF NOT EXISTS album_media_moved
AFTER UPDATE OF album_id ON album_media
WHEN OLD.album_id IS NOT NEW.album_id
BEGIN
  UPDATE albums SET item_count = item_count - 1 WHERE id = OLD.album_id;
  UPDATE albums SET item_count = item_count + 1 WHERE id = NEW.album_id;
END;

CREATE TRIGGER IF NOT EXISTS album_media_refiled
AFTER UPDATE OF folder_id ON album_media
WHEN OLD.folder_id IS NOT NEW.folder_id
BEGIN
  UPDATE folders SET item_count = item_count - 1 WHERE id = OLD.folder_id;
  UPDATE folders SET item_count = item_count + 1 WHERE id = NEW.folder_id;
END;
