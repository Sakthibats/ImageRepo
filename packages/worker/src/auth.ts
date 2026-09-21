import type { Context, Next } from 'hono';
import type { Env } from './types.js';

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
 * Guards /admin/*. The ingest CLI cannot complete Cloudflare Access's
 * interactive browser login, so it presents a bearer token instead.
 */
export function requireAdmin() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const expected = c.env.ADMIN_TOKEN;
    if (!expected) {
      return c.json({ error: 'ADMIN_TOKEN is not configured on the Worker' }, 500);
    }
    const header = c.req.header('authorization') ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!presented || !timingSafeEqual(presented, expected)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  };
}
