import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/**
 * Content address for a file: first 32 hex chars of sha256.
 * 128 bits — collision risk across a few million files is nil, and it keeps
 * URLs short. Streaming, so a 2GB video costs no meaningful memory.
 */
export async function hashFile(path: string): Promise<string> {
  const h = createHash('sha256');
  const stream = createReadStream(path, { highWaterMark: 1024 * 1024 });
  for await (const chunk of stream) h.update(chunk as Buffer);
  return h.digest('hex').slice(0, 32);
}
