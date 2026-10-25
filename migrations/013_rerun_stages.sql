-- Re-running a stage over the library (a new stage, or a new version of one)
-- is one pass through media in id order. Each pass keeps its place here, so a
-- claim carries on where the last stopped, a restarted service resumes, and a
-- finished pass costs a row to check instead of a scan of the library.
-- `day` and `claimed` count what was handed out that day, for the daily cap.
CREATE TABLE IF NOT EXISTS stage_sweeps (
  stage        TEXT NOT NULL,
  version      INTEGER NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('photo','video')),
  after        TEXT NOT NULL DEFAULT '',   -- the last media id the pass reached
  finished_at  INTEGER,
  day          INTEGER NOT NULL DEFAULT 0, -- days since 1970, UTC
  claimed      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (stage, version, kind)
);

-- Bumped when a re-run rewrites a photo's served files (drv/, post/, prev/).
-- It goes in their URLs (?r=), or browsers would keep the old copies for a
-- year: keys never change, and their responses are cached as immutable.
ALTER TABLE media ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
