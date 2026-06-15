import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// Play-money mode (REAL_FUNDS intentionally unset): proves the economics endpoint serves here while the
// real-funds-only treasury endpoint stays off — the decouple that keeps the Overview boxes from vanishing.
process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.ADMIN_API_KEY = 'econ-test-admin-key-with-enough-entropy-1';
process.env.RATE_LIMIT_DISABLED = 'true';

const { initDb } = await import('../db/init.ts');
const { buildServer } = await import('../server.ts');
await initDb();
const app = await buildServer();
after(() => app.close());
const KEY = { 'x-admin-key': process.env.ADMIN_API_KEY };

test('/admin/economics serves in play-money; /admin/treasury stays gated off', async () => {
  const econ = await app.inject({ method: 'GET', url: '/admin/economics', headers: KEY });
  assert.equal(econ.statusCode, 200, 'economics serves in play-money mode');
  const b = econ.json();
  for (const k of ['freeE6', 'lockedE6', 'customerLpE6', 'insuranceE6', 'feeRevenueE6', 'fundingCollectedE6', 'fundingRevenueE6', 'pnlBreakdown']) {
    assert.ok(k in b, `economics response missing ${k}`);
  }
  assert.ok('totalE6' in b.pnlBreakdown, 'pnlBreakdown included');
  const treas = await app.inject({ method: 'GET', url: '/admin/treasury', headers: KEY });
  assert.equal(treas.statusCode, 404, 'treasury route correctly gated off in play-money (economics unaffected)');
});

test('/admin/economics requires the operator key', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/admin/economics' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/admin/economics', headers: { 'x-admin-key': 'wrong-key' } })).statusCode, 401);
});
