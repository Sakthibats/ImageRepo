import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type FileStatus = 'pending' | 'processed' | 'uploaded' | 'recorded' | 'failed' | 'skipped';

export interface FileRow {
  path: string;
  album: string;
  kind: 'photo' | 'video';
  size: number;
  mtime: number;
  hash: string | null;
  status: FileStatus;
  error: string | null;
  derivatives: string | null;
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
        kind        TEXT NOT NULL,
        size        INTEGER NOT NULL,
        mtime       INTEGER NOT NULL,
        hash        TEXT,
        status      TEXT NOT NULL DEFAULT 'pending',
        error       TEXT,
        derivatives TEXT,
        updated_at  INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_status ON files(status);
      CREATE INDEX IF NOT EXISTS idx_hash   ON files(hash);
    `);
  }

  /** Insert if new; reset to pending if the file changed on disk since last run. */
  upsert(f: Omit<FileRow, 'hash' | 'status' | 'error' | 'derivatives'>): void {
    this.db.prepare(`
      INSERT INTO files (path, album, kind, size, mtime, updated_at)
      VALUES (@path, @album, @kind, @size, @mtime, unixepoch())
      ON CONFLICT(path) DO UPDATE SET
        album  = excluded.album,
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
