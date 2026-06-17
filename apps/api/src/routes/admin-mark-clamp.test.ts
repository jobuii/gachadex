import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// The /admin/mark-clamp knob endpoint registers whenever ADMIN_API_KEY is set (like the other live
// knobs). Exercised over HTTP via inject.
process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.RATE_LIMIT_DISABLED = 'true';
process.env.ADMIN_API_KEY = 'test-admin-key-with-enough-entropy-123456';

const { buildServer } = await import('../server.ts');
const { initDb } = await import('../db/init.ts');
const { getDb, closeDb } = await import('../db/client.ts');

await initDb();
const db = await getDb();
const app = await buildServer();
after(async () => {
  await app.close();
  await closeDb();
});

const KEY = { 'x-admin-key': process.env.ADMIN_API_KEY! };
const get = () => app.inject({ method: 'GET', url: '/admin/mark-clamp', headers: KEY });
const post = (body: unknown, headers: Record<string, string> = KEY) =>
  app.inject({ method: 'POST', url: '/admin/mark-clamp', headers, payload: body as object });

test('GET /admin/mark-clamp returns the current bps + the default (25% before any override)', async () => {
  const res = await get();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { bps: 2500, default: 2500 });
});

test('POST /admin/mark-clamp persists the new value to settings and reflects it back', async () => {
  const res = await post({ bps: 1500 });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().bps, 1500);

  // written to the DB (the live-knob settings row) — the "into database" half
  const row = await db.query<{ value: string }>(`SELECT value FROM settings WHERE key = 'mark_clamp_bps'`);
  assert.equal(row.rows[0]?.value, '1500');
  assert.equal((await get()).json().bps, 1500, 'a later read returns the persisted value');
});

test('POST /admin/mark-clamp rejects out-of-range bps with 400 (bounds 100-9000)', async () => {
  assert.equal((await post({ bps: 50 })).statusCode, 400, 'below the floor');
  assert.equal((await post({ bps: 99999 })).statusCode, 400, 'above the ceiling');
  // and the rejected writes did not move the knob off its last good value
  assert.equal((await get()).json().bps, 1500);
});

test('the mark-clamp routes require the admin key', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/admin/mark-clamp' })).statusCode, 401);
  assert.equal((await post({ bps: 2000 }, {})).statusCode, 401);
});
