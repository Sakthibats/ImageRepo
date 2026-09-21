import { thumbHashToDataURL } from 'thumbhash';

const cache = new Map<string, string>();

/**
 * ThumbHash -> data URL, memoised. Each hash is ~28 bytes and decodes to a
 * blurred approximation, so a grid paints something meaningful on first frame
 * instead of grey rectangles.
 */
export function thumbhashUrl(hash: string | undefined): string | undefined {
  if (!hash) return undefined;
  const hit = cache.get(hash);
  if (hit) return hit;
  try {
    const bytes = Uint8Array.from(atob(hash), (c) => c.charCodeAt(0));
    const url = thumbHashToDataURL(bytes);
    cache.set(hash, url);
    return url;
  } catch {
    return undefined;
  }
}
