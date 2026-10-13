import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface FileRow {
  path: string;
  album: string;
  albumTitle: string;
  kind: 'photo' | 'video';
  size: number;
  mtime: number;
  hash: string | null;
  /** Set when the file could not even be read; stage failures live in stage_runs. */
  error: string | null;
  /** The recordKey this file was last sent to the Worker with, if any. */
  recordedKey: string | null;
}

export interface StageRun {
  stage: string;
  version: number;
  state: 'done' | 'failed';
  attempts: number;
  error: string | null;
  data: unknown;
}

/** A row from a ledger written before stages existed. */
export interface LegacyRow {
  path: string; kind: 'photo' | 'video'; album: string; hash: string | null;
  status: string; record: string | null;
}

const FILE_COLS = `path, album, COALESCE(album_title, album) AS albumTitle, kind, size, mtime,
                   hash, error, recorded_key AS recordedKey`;

/**
 * Local ingest ledger. This is what makes a 100GB overnight run resumable:
 * every stage's result is committed as it happens, so an interrupted run
 * picks up exactly where it stopped instead of redoing 13,000 files.
 *
 * Two tables, because two different things are being remembered:
 *   files       one row per path — which album it is filed under, and whether
 *               that has been recorded in the database
 *   stage_runs  one row per (content hash, stage) — the processing itself,
 *               which belongs to the bytes, not to where they happen to sit
 */
export class IngestState {
  private db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path         TEXT PRIMARY KEY,
        album        TEXT NOT NULL,
        album_title  TEXT,
        kind         TEXT NOT NULL,
        size         INTEGER NOT NULL,
        mtime        INTEGER NOT NULL,
        hash         TEXT,
        status       TEXT NOT NULL DEFAULT 'pending',
        error        TEXT,
        derivatives  TEXT,
        record       TEXT,
        recorded_key TEXT,
        updated_at   INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_status ON files(status);
      CREATE INDEX IF NOT EXISTS idx_hash   ON files(hash);

      CREATE TABLE IF NOT EXISTS stage_runs (
        hash       TEXT NOT NULL,
        stage      TEXT NOT NULL,
        version    INTEGER NOT NULL,
        state      TEXT NOT NULL,
        attempts   INTEGER NOT NULL DEFAULT 1,
        error      TEXT,
        data       TEXT,
        updated_at INTEGER,
        PRIMARY KEY (hash, stage)
      );
    `);
    // Columns added since the first ledgers were written.
    const cols = this.db.prepare(`PRAGMA table_info(files)`).all() as { name: string }[];
    for (const col of ['record', 'album_title', 'recorded_key']) {
      if (!cols.some((c) => c.name === col)) this.db.exec(`ALTER TABLE files ADD COLUMN ${col} TEXT`);
    }
  }

  // ------------------------------------------------------------------ files

  /** Insert if new; forget everything known about the file if it changed on disk. */
  upsert(f: Pick<FileRow, 'path' | 'album' | 'albumTitle' | 'kind' | 'size' | 'mtime'>): void {
    this.db.prepare(`
      INSERT INTO files (path, album, album_title, kind, size, mtime, updated_at)
      VALUES (@path, @album, @albumTitle, @kind, @size, @mtime, unixepoch())
      ON CONFLICT(path) DO UPDATE SET
        album        = excluded.album,
        album_title  = excluded.album_title,
        kind         = excluded.kind,
        hash         = CASE WHEN files.size <> excluded.size OR files.mtime <> excluded.mtime
                            THEN NULL ELSE files.hash END,
        recorded_key = CASE WHEN files.size <> excluded.size OR files.mtime <> excluded.mtime
                            THEN NULL ELSE files.recorded_key END,
        error        = NULL,
        size         = excluded.size,
        mtime        = excluded.mtime
    `).run(f);
  }

  /** Rows for the given paths, or the whole ledger. */
  files(paths?: string[]): FileRow[] {
    const all = this.db.prepare(`SELECT ${FILE_COLS} FROM files ORDER BY album, path`).all() as FileRow[];
    if (!paths) return all;
    const wanted = new Set(paths);
    return all.filter((f) => wanted.has(f.path));
  }

  setHash(path: string, hash: string) {
    this.db.prepare(`UPDATE files SET hash=?, updated_at=unixepoch() WHERE path=?`).run(hash, path);
  }

  setError(path: string, error: string | null) {
    this.db.prepare(`UPDATE files SET error=?, updated_at=unixepoch() WHERE path=?`).run(error, path);
  }

  setRecorded(path: string, key: string | null) {
    this.db.prepare(`UPDATE files SET recorded_key=?, updated_at=unixepoch() WHERE path=?`).run(key, path);
  }

  /** A human-readable summary, kept only for anyone opening the ledger by hand. */
  setStatus(path: string, status: string) {
    this.db.prepare(`UPDATE files SET status=? WHERE path=?`).run(status, path);
  }

  // ------------------------------------------------------------- stage runs

  /** Every stage result, grouped by content hash. */
  runs(): Map<string, Map<string, StageRun>> {
    const rows = this.db.prepare(
      `SELECT hash, stage, version, state, attempts, error, data FROM stage_runs`
    ).all() as (Omit<StageRun, 'data'> & { hash: string; data: string | null })[];
    const out = new Map<string, Map<string, StageRun>>();
    for (const { hash, data, ...r } of rows) {
      if (!out.has(hash)) out.set(hash, new Map());
      out.get(hash)!.set(r.stage, { ...r, data: data ? JSON.parse(data) : null });
    }
    return out;
  }

  saveRun(hash: string, stage: string, version: number, data: unknown) {
    this.db.prepare(`
      INSERT INTO stage_runs (hash, stage, version, state, attempts, error, data, updated_at)
      VALUES (?, ?, ?, 'done', 1, NULL, ?, unixepoch())
      ON CONFLICT(hash, stage) DO UPDATE SET
        version = excluded.version, state = 'done', error = NULL, data = excluded.data,
        attempts = stage_runs.attempts + 1, updated_at = excluded.updated_at
    `).run(hash, stage, version, JSON.stringify(data ?? null));
  }

  failRun(hash: string, stage: string, version: number, error: string) {
    this.db.prepare(`
      INSERT INTO stage_runs (hash, stage, version, state, attempts, error, data, updated_at)
      VALUES (?, ?, ?, 'failed', 1, ?, NULL, unixepoch())
      ON CONFLICT(hash, stage) DO UPDATE SET
        version = excluded.version, state = 'failed', error = excluded.error, data = NULL,
        attempts = stage_runs.attempts + 1, updated_at = excluded.updated_at
    `).run(hash, stage, version, error.slice(0, 500));
  }

  clearRuns(hash: string) {
    this.db.prepare(`DELETE FROM stage_runs WHERE hash=?`).run(hash);
  }

  // ------------------------------------------------------------ pre-stages

  /** 0 = written before stages existed and not yet converted. */
  get schemaVersion(): number {
    return this.db.pragma('user_version', { simple: true }) as number;
  }
  set schemaVersion(v: number) { this.db.pragma(`user_version = ${Math.trunc(v)}`); }

  legacyRows(): LegacyRow[] {
    return this.db.prepare(`SELECT path, kind, album, hash, status, record FROM files`).all() as LegacyRow[];
  }

  transaction(fn: () => void) { this.db.transaction(fn)(); }

  // ---------------------------------------------------------------- totals

  /** Album id -> human title, as seen on disk. */
  albumTitles(): { id: string; title: string }[] {
    return this.db.prepare(
      `SELECT album AS id, COALESCE(MAX(album_title), album) AS title FROM files GROUP BY album`
    ).all() as { id: string; title: string }[];
  }

  close() { this.db.close(); }
}
