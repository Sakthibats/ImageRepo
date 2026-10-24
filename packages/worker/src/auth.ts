import type { Context, Next } from 'hono';
import type { Env } from './types.js';
import { verifiedClaims } from './access.js';

/**
 * Constant-time string comparison. A plain `===` leaks the length of the
 * matching prefix through timing, which is enough to recover a token one
 * character at a time given sufficient requests.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  // Compare lengths without early-exit, then compare bytes over a fixed span.
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) {
    diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  }
  return diff === 0;
}

/**
 * What the processing service may call. It holds credentials on whatever
 * machine runs it, so a leaked token should not be able to delete, share or
 * re-file anything: it takes work and hands back results, nothing more.
 */
const SERVICE_PATHS = /^\/admin\/(health|inbox\/(claim|complete|fail|summary)|stages\/[a-z]+)\/?$/;

/**
 * Guards /admin/*. Two callers, two credentials:
 *
 *   - The admin UI runs in a browser that has already passed Cloudflare
 *     Access, so it presents the signed Access JWT. It has no bearer token
 *     and cannot be given one without shipping a secret to the client.
 *   - The ingest CLI cannot complete Access's interactive browser login, so
 *     it presents ADMIN_TOKEN (and an Access service token to get past Access
 *     itself).
 *
 * Either is sufficient; the Access policy is what restricts the JWT path to
 * the owner's own identity.
 *
 * The processing service has its own Access service token. Its JWT names that
 * token's Client ID as common_name, and is held to SERVICE_PATHS.
 */
export function requireAdmin() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    // Verified, not merely present: this Worker is reachable directly on
    // workers.dev, so an unchecked assertion header proves nothing.
    const claims = await verifiedClaims(c.req.raw, c.env);
    if (claims) {
      const service = c.env.PREPROCESS_CLIENT_ID?.trim();
      if (service && claims.common_name === service && !SERVICE_PATHS.test(c.req.path)) {
        return c.json({ error: 'not allowed for the processing service' }, 403);
      }
      return next();
    }

    const expected = c.env.ADMIN_TOKEN;
    if (!expected) {
      return c.json({ error: 'ADMIN_TOKEN is not configured on the Worker' }, 500);
    }
    const header = c.req.header('authorization') ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (presented && timingSafeEqual(presented, expected)) return next();

    return c.json({ error: 'unauthorized' }, 401);
  };
}
