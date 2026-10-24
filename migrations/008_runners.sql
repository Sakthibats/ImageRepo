-- Processing services that have checked in, so the app can say whether an
-- upload will be processed now or wait for one to start. One row per runner
-- name; a service checks in every 20 seconds and checks out when it stops.
CREATE TABLE IF NOT EXISTS runners (
  name       TEXT PRIMARY KEY,
  kinds      TEXT NOT NULL,             -- what it takes: 'photo', 'video' or 'photo,video'
  busy       INTEGER NOT NULL DEFAULT 0, -- files in hand at the last check-in
  state      TEXT NOT NULL CHECK (state IN ('running','stopped')),
  last_seen  INTEGER NOT NULL           -- epoch seconds
);
