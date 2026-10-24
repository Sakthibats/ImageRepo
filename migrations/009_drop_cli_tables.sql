-- Tables only the retired laptop CLI used. ingest_log was written per record
-- and never read; settings held the purge epoch the CLI watched. No code has
-- referred to either since the CLI was removed.
DROP TABLE IF EXISTS ingest_log;
DROP TABLE IF EXISTS settings;
