import { Hono } from 'hono';
import type { Env } from './types.js';
import { admin } from './admin.js';
import { assets } from './assets.js';
import { guest } from './guest.js';

const app = new Hono<{ Bindings: Env }>();

app.get('/', (c) => c.json({ service: 'imagerepo-api', ok: true }));

app.route('/admin', admin);
app.route('/a', assets);
app.route('/s', guest);

app.notFound((c) => c.json({ error: 'not found' }, 404));

app.onError((err, c) => {
  console.error('unhandled:', err?.stack ?? err);
  // Never echo the raw error to the client — D1 errors can contain row data.
  return c.json({ error: 'internal error' }, 500);
});

export default app;
