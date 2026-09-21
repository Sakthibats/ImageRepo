import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type FileStatus = 'pending' | 'processed' | 'uploaded' | 'recorded' | 'failed' | 'skipped';

export interface FileRow {
  path: string;
  album: string;
  albumTitle: string;
  kind: 'photo' | 'video';
  size: number;
  mtime: number;
  hash: string | null;
  status: FileStatus;
  error: string | null;
  derivatives: string | null;
  record: string | null;
}

/**
 * Local ingest ledger. This is what makes a 100GB overnight run resumable:
 * every file's progress is committed as it happens, so an interrupted run
 * picks up exactly where it stopped instead of re-hashing 13,000 files.
 */
export class IngestState {
  private db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path        TEXT PRIMARY KEY,
        album       TEXT NOT NULL,
        album_title TEXT,
        kind        TEXT NOT NULL,
        size        INTEGER NOT NULL,
        mtime       INTEGER NOT NULL,
        hash        TEXT,
        status      TEXT NOT NULL DEFAULT 'pending',
        error       TEXT,
        derivatives TEXT,
        record      TEXT,
        updated_at  INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_status ON files(status);
      CREATE INDEX IF NOT EXISTS idx_hash   ON files(hash);
    `);
    // Migration for ledgers created before `record` existed.
    const cols = this.db.prepare(`PRAGMA table_info(files)`).all() as { name: string }[];
    if (!cols.some((c) => c.name === 'record')) {
      this.db.exec(`ALTER TABLE files ADD COLUMN record TEXT`);
    }
    if (!cols.some((c) => c.name === 'album_title')) {
      this.db.exec(`ALTER TABLE files ADD COLUMN album_title TEXT`);
    }
  }

  /** Insert if new; reset to pending if the file changed on disk since last run. */
  upsert(f: Omit<FileRow, 'hash' | 'status' | 'error' | 'derivatives' | 'record'>): void {
    this.db.prepare(`
      INSERT INTO files (path, album, album_title, kind, size, mtime, updated_at)
      VALUES (@path, @album, @albumTitle, @kind, @size, @mtime, unixepoch())
      ON CONFLICT(path) DO UPDATE SET
        album       = excluded.album,
        album_title = excluded.album_title,
        size   = excluded.size,
        mtime  = excluded.mtime,
        status = CASE WHEN files.size <> excluded.size OR files.mtime <> excluded.mtime
                      THEN 'pending' ELSE files.status END,
        hash   = CASE WHEN files.size <> excluded.size OR files.mtime <> excluded.mtime
                      THEN NULL ELSE files.hash END
    `).run(f);
  }

  setHash(path: string, hash: string) {
    this.db.prepare(`UPDATE files SET hash=?, updated_at=unixepoch() WHERE path=?`).run(hash, path);
  }

  setStatus(path: string, status: FileStatus, error?: string, derivatives?: string[]) {
    this.db.prepare(
      `UPDATE files SET status=?, error=?, derivatives=COALESCE(?, derivatives), updated_at=unixepoch() WHERE path=?`
    ).run(status, error ?? null, derivatives ? JSON.stringify(derivatives) : null, path);
  }

  /**
   * Stores the computed metadata alongside the file. Processing is expensive
   * (hash + decode + derive); the POST that ships it is not. Persisting here
   * means an unreachable Worker costs a retry, not hours of recomputation.
   */
  saveRecord(path: string, record: unknown) {
    this.db.prepare(`UPDATE files SET record=? WHERE path=?`)
      .run(JSON.stringify(record), path);
  }

  /** Files whose bytes are up but whose metadata never reached the Worker. */
  unrecorded(): { path: string; record: string }[] {
    return this.db.prepare(
      `SELECT path, record FROM files
       WHERE record IS NOT NULL AND status IN ('uploaded','processed')
       ORDER BY album, path`
    ).all() as { path: string; record: string }[];
  }

  /** Album id -> human title, as seen on disk. Lets `flush` name albums properly. */
  albumTitles(): { id: string; title: string }[] {
    return this.db.prepare(
      `SELECT album AS id, COALESCE(MAX(album_title), album) AS title
       FROM files GROUP BY album`
    ).all() as { id: string; title: string }[];
  }

  pending(limit?: number): FileRow[] {
    const sql = `SELECT * FROM files WHERE status IN ('pending','failed') ORDER BY album, path`
      + (limit ? ` LIMIT ${limit}` : '');
    return this.db.prepare(sql).all() as FileRow[];
  }

  /** Same bytes already handled under a different path — dedupe without re-work. */
  findByHash(hash: string): FileRow | undefined {
    return this.db.prepare(
      `SELECT * FROM files WHERE hash=? AND status IN ('uploaded','recorded') LIMIT 1`
    ).get(hash) as FileRow | undefined;
  }

  counts(): Record<string, number> {
    const rows = this.db.prepare(`SELECT status, COUNT(*) n FROM files GROUP BY status`).all() as
      { status: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  albums(): { album: string; n: number }[] {
    return this.db.prepare(
      `SELECT album, COUNT(*) n FROM files GROUP BY album ORDER BY album`
    ).all() as { album: string; n: number }[];
  }

  totalBytes(): number {
    const r = this.db.prepare(`SELECT COALESCE(SUM(size),0) b FROM files`).get() as { b: number };
    return r.b;
  }

  close() { this.db.close(); }
}
