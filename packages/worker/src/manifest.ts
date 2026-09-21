import { r2Key } from '@imagerepo/shared';
import type { AlbumManifest, ManifestItem, OwnerManifestItem } from '@imagerepo/shared';
import { albumMedia, listAlbums } from './db.js';

/**
 * Baking turns a D1 query into a static JSON file on R2. Reads then hit a
 * CDN-cached object instead of the database, which is why a viewer on the
 * other side of the world does not pay for D1 living in one region.
 *
 * Two shapes are emitted per album:
 *   <id>.owner.<ver>.json   includes lat/lon/place
 *   <id>.guest.<ver>.json   coordinates are never written into this file
 *
 * The split is structural rather than a filter applied at request time: a
 * guest manifest cannot leak location because location was never serialised
 * into it.
 */

export type Audience = 'owner' | 'guest';

export const manifestKey = (albumId: string, audience: Audience, ver: string) =>
  `man/album/${albumId}.${audience}.${ver}.json`;

export const indexKey = (audience: Audience, ver: string) =>
  `man/index.${audience}.${ver}.json`;

function toGuestItem(row: any): ManifestItem {
  const item: ManifestItem = {
    id: row.id,
    k: row.kind,
    w: row.width ?? 0,
    h: row.height ?? 0,
  };
  if (row.taken_at) item.t = row.taken_at;
  if (row.thumbhash) item.th = row.thumbhash;
  if (row.duration_ms) item.d = row.duration_ms;
  if (row.caption) item.c = row.caption;
  return item;
}

function toOwnerItem(row: any): OwnerManifestItem {
  const item = toGuestItem(row) as OwnerManifestItem;
  if (row.lat != null) item.lat = row.lat;
  if (row.lon != null) item.lon = row.lon;
  if (row.place) item.place = row.place;
  return item;
}

/** Short random version token; changing it busts every cached copy at once. */
export function newVersion(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 8);
}

export async function bakeAlbum(
  db: D1Database,
  bucket: R2Bucket,
  albumId: string,
): Promise<{ ver: string; count: number }> {
  const album = await db.prepare(`SELECT id, title FROM albums WHERE id = ?1`)
    .bind(albumId).first<{ id: string; title: string }>();
  if (!album) throw new Error(`no such album: ${albumId}`);

  const { results } = await albumMedia(db, albumId);
  const ver = newVersion();

  const write = async (audience: Audience, items: ManifestItem[]) => {
    const body: AlbumManifest = {
      album: album.id, title: album.title, ver, count: items.length, items,
    };
    await bucket.put(manifestKey(albumId, audience, ver), JSON.stringify(body), {
      httpMetadata: {
        contentType: 'application/json',
        // Versioned filename, so the content at this key never changes.
        cacheControl: 'public, max-age=31536000, immutable',
      },
    });
  };

  await write('owner', (results as any[]).map(toOwnerItem));
  await write('guest', (results as any[]).map(toGuestItem));

  // Give a new album a cover so the album list is not a wall of blank tiles.
  // Prefer a photo: a video poster is a frame grab and often less recognisable.
  if (results.length) {
    const rows = results as any[];
    const pick = rows.find((r) => r.kind === 'photo') ?? rows[0];
    await db.prepare(
      `UPDATE albums SET cover_id = ?1 WHERE id = ?2 AND cover_id IS NULL`
    ).bind(pick.id, albumId).run();
  }

  await db.prepare(`UPDATE albums SET manifest_ver = ?1, updated_at = ?2 WHERE id = ?3`)
    .bind(ver, Math.floor(Date.now() / 1000), albumId).run();

  return { ver, count: results.length };
}

/**
 * The index is what the app loads first: album list, counts, cover ids.
 * Deliberately small and mutable — it is the pointer that makes the
 * immutable per-album manifests discoverable.
 */
export async function bakeIndex(db: D1Database, bucket: R2Bucket): Promise<number> {
  const { results } = await listAlbums(db);
  const ver = newVersion();

  for (const audience of ['owner', 'guest'] as Audience[]) {
    const body = {
      ver,
      albums: (results as any[]).map((a) => ({
        id: a.id,
        title: a.title,
        n: a.n,
        cover: a.cover_id,
        ver: a.manifest_ver,
        updated: a.updated_at,
      })),
    };
    await bucket.put(indexKey(audience, 'current'), JSON.stringify(body), {
      httpMetadata: {
        contentType: 'application/json',
        // Mutable pointer: short TTL, revalidate in the background.
        cacheControl: 'public, max-age=60, stale-while-revalidate=300',
      },
    });
  }
  return results.length;
}

export { r2Key };
