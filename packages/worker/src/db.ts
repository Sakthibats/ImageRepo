import type { MediaRecord } from '@imagerepo/shared';

/**
 * D1 caps the number of bound parameters per statement, so we insert one row
 * per statement and let batch() run them in a single transaction. That keeps
 * a 200-record ingest to one round trip without risking the parameter limit.
 */
const MEDIA_COLS = 24;

/** A camera's metadata is a few KB; anything far beyond that is a malformed file. */
const MAX_RAW_META = 32 * 1024;

export async function upsertAlbums(
  db: D1Database,
  albums: { id: string; title: string; seededFrom?: string }[],
): Promise<number> {
  if (!albums.length) return 0;
  const now = Math.floor(Date.now() / 1000);

  const stmt = db.prepare(`
    INSERT INTO albums (id, title, created_at, updated_at, seeded_from)
    VALUES (?1, ?2, ?3, ?3, ?4)
    ON CONFLICT(id) DO UPDATE SET
      -- Never clobber a title the user has since edited in the admin UI.
      title       = CASE WHEN albums.seeded_from IS NOT NULL
                          AND albums.title = albums.seeded_from
                         THEN excluded.title ELSE albums.title END,
      updated_at  = excluded.updated_at
  `);

  await db.batch(albums.map((a) => stmt.bind(a.id, a.title, now, a.seededFrom ?? null)));
  return albums.length;
}

/**
 * Guarantees album rows exist without touching any that already do. Used as a
 * safety net before inserting media: referencing a missing album would fail
 * the whole batch, but we must not overwrite a real title with a slug.
 */
export async function ensureAlbumRows(db: D1Database, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare(`
    INSERT INTO albums (id, title, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?3)
    ON CONFLICT(id) DO NOTHING
  `);
  await db.batch(ids.map((id) => stmt.bind(id, id, now)));
}

export async function insertMedia(db: D1Database, records: MediaRecord[]): Promise<number> {
  if (!records.length) return 0;
  const now = Math.floor(Date.now() / 1000);

  const media = db.prepare(`
    INSERT INTO media (
      id, kind, ext, bytes, width, height, duration_ms,
      taken_at, uploaded_at, camera, lens, iso, fstop, focal_mm,
      lat, lon, place, thumbhash, caption, orig_name, source_path, raw_meta
    ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22)
    ON CONFLICT(id) DO UPDATE SET
      -- Content-addressed: same id means same bytes. Refresh derived metadata
      -- but preserve anything the user has edited (caption, place).
      width     = excluded.width,
      height    = excluded.height,
      taken_at  = COALESCE(media.taken_at, excluded.taken_at),
      thumbhash = excluded.thumbhash,
      raw_meta  = COALESCE(excluded.raw_meta, media.raw_meta)
  `);

  const link = db.prepare(`
    INSERT INTO album_media (album_id, media_id, position)
    VALUES (?1, ?2, ?3)
    ON CONFLICT(album_id, media_id) DO NOTHING
  `);

  const logStmt = db.prepare(`
    INSERT INTO ingest_log (media_id, derivatives, ingested_at, cli_version)
    VALUES (?1, ?2, ?3, ?4)
    ON CONFLICT(media_id) DO UPDATE SET
      derivatives = excluded.derivatives, ingested_at = excluded.ingested_at
  `);

  const statements: D1PreparedStatement[] = [];
  for (const r of records) {
    statements.push(media.bind(
      r.id, r.kind, r.ext, r.bytes,
      r.width ?? null, r.height ?? null, r.durationMs ?? null,
      r.takenAt ?? null, now,
      r.camera ?? null, r.lens ?? null, r.iso ?? null, r.fstop ?? null, r.focalMm ?? null,
      r.lat ?? null, r.lon ?? null, r.place ?? null,
      r.thumbhash ?? null, r.caption ?? null, r.origName, r.sourcePath ?? null,
      r.rawMeta ? JSON.stringify(r.rawMeta).slice(0, MAX_RAW_META) : null,
    ));
    // taken_at ordering gives a sensible default position within the album.
    for (const albumId of r.albums) {
      statements.push(link.bind(albumId, r.id, r.takenAt ?? 0));
    }
    statements.push(logStmt.bind(r.id, JSON.stringify(r.derivatives), now, '0.1.0'));

    // One statement for all of a record's stages, to keep the batch short.
    const stages = (r.stages ?? []).filter((s) => s?.name && Number.isInteger(s.version)).slice(0, 12);
    if (stages.length) {
      const rows = stages.map((_, i) => `(?1, ?${i * 2 + 3}, ?${i * 2 + 4}, 'done', 1, NULL, 'cli', ?2)`);
      statements.push(db.prepare(`
        INSERT INTO media_stages (media_id, stage, version, state, attempts, error, runner, updated_at)
        VALUES ${rows.join(', ')}
        ON CONFLICT(media_id, stage) DO UPDATE SET
          version = excluded.version, state = 'done', error = NULL, lease_until = NULL,
          runner = excluded.runner, updated_at = excluded.updated_at
      `).bind(r.id, now, ...stages.flatMap((s) => [s.name, s.version])));
    }
  }

  await db.batch(statements);
  return records.length;
}

export interface AlbumRow {
  id: string; title: string; description: string | null;
  cover_id: string | null; created_at: number; updated_at: number;
  manifest_ver: string | null; n: number; newest: number | null;
}

export function listAlbums(db: D1Database) {
  // `newest` is the date of the most recent photo in the album, which is what
  // people actually mean by "most recent album" — albums.updated_at changes on
  // every re-bake and so sorts by nothing useful.
  return db.prepare(`
    SELECT a.*, COUNT(am.media_id) AS n, MAX(m.taken_at) AS newest
    FROM albums a
    LEFT JOIN album_media am ON am.album_id = a.id
    LEFT JOIN media m ON m.id = am.media_id
    GROUP BY a.id
    ORDER BY a.title
  `).all<AlbumRow>();
}

export function albumMedia(db: D1Database, albumId: string) {
  return db.prepare(`
    SELECT m.id, m.kind, m.width, m.height, m.taken_at, m.thumbhash,
           m.duration_ms, m.caption, m.lat, m.lon, m.place, am.folder_id
    FROM album_media am
    JOIN media m ON m.id = am.media_id
    WHERE am.album_id = ?1
    ORDER BY COALESCE(m.taken_at, 0), m.id
  `).bind(albumId).all();
}

export { MEDIA_COLS };
