import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// R9 public index basket view + R11 hand removal routes (index rules v3).
process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.RATE_LIMIT_DISABLED = 'true';
process.env.ADMIN_API_KEY = 'test-admin-key-with-enough-entropy-123456';

const { buildServer } = await import('../server.ts');
const { initDb } = await import('../db/init.ts');
const { getDb, closeDb } = await import('../db/client.ts');
const { config } = await import('../config.ts');
const { ingest } = await import('../services/oracle.ts');

await initDb();
const db = await getDb();
const app = await buildServer();
after(async () => { await app.close(); await closeDb(); });
const KEY = { 'x-admin-key': process.env.ADMIN_API_KEY };
const oc = (id: string, usd: number) => ({
  game: 'pokemon', symbol: `pokemon:${id}`, cardId: id, displayName: `${id} #1`, variant: null, imageSmall: null,
  rawE6: BigInt(usd * 1e6), observedAt: new Date(), featured: true, productType: 'single' as const,
});

test('GET /markets/index-basket: members after launch; 400 on a bad symbol, 404 on an unknown index', async () => {
  const cfg = config as { indexRulesV3: boolean };
  await ingest(db, async () => [oc('a', 100), oc('b', 50)]);
  cfg.indexRulesV3 = true;
  try {
    await ingest(db, async () => [oc('a', 101), oc('b', 50)]);
  } finally {
    cfg.indexRulesV3 = false;
  }
  const r = await app.inject({ method: 'GET', url: '/markets/index-basket?symbol=INDEX:gp-top-100' });
  assert.equal(r.statusCode, 200, r.body);
  const v = r.json();
  assert.equal(v.basket, 'pokemon:top-100', 'a G&P series shows its shared basket');
  assert.deepEqual(v.members.map((m: { name: string }) => m.name), ['a #1', 'b #1']);
  assert.equal(v.governed, true);
  assert.equal(v.upcoming, null);
  assert.equal((await app.inject({ method: 'GET', url: '/markets/index-basket?symbol=nope' })).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: '/markets/index-basket?symbol=INDEX:missing' })).statusCode, 404);
});

test('admin index exclusions: key required, reason required, add → list → clear', async () => {
  const mid = (await db.query<{ id: string }>(`SELECT id FROM markets WHERE symbol = 'pokemon:a'`)).rows[0].id;
  assert.equal((await app.inject({ method: 'GET', url: '/admin/index-exclusions' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/admin/index-exclusions', headers: KEY, payload: { marketId: mid } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/admin/index-exclusions', headers: KEY, payload: { marketId: 'nope', reason: 'x' } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/admin/index-exclusions', headers: KEY, payload: { marketId: mid, reason: 'fake sale' } })).statusCode, 200);
  const list = (await app.inject({ method: 'GET', url: '/admin/index-exclusions', headers: KEY })).json();
  assert.deepEqual(list.exclusions.map((e: { reason: string }) => e.reason), ['fake sale']);
  const cleared = (await app.inject({ method: 'DELETE', url: `/admin/index-exclusions/${mid}`, headers: KEY })).json();
  assert.equal(cleared.cleared, true);
});
