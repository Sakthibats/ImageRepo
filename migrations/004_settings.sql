-- Small facts about the library as a whole.
CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- Changed by every full purge. The CLI remembers the value it last saw, and a
-- different one tells it the uploads its local ledger remembers are gone.
INSERT OR IGNORE INTO settings (key, value) VALUES ('library_epoch', 'initial');
