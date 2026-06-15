import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// The CHAT admin view routes (/admin/chat/*) register whenever ADMIN_API_KEY is set — including
// play-money mode (no REAL_FUNDS), like the fee/customers routes. Exercised over HTTP via inject.
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

const KEY = { 'x-admin-key': process.env.ADMIN_API_KEY };

async function newUser(pubkey?: string): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1, $2)`, [id, pubkey ?? 'pk-' + id.slice(0, 8)]);
  return id;
}

test('every /admin/chat route requires the operator key', async () => {
  for (const [method, url] of [
    ['GET', '/admin/chat/thresholds'],
    ['POST', '/admin/chat/thresholds'],
    ['GET', '/admin/chat/drop-config'],
    ['POST', '/admin/chat/drop-config'],
    ['GET', '/admin/chat/drop'],
    ['GET', '/admin/chat/mods'],
    ['POST', '/admin/chat/mods/x'],
  ] as const) {
    const r = await app.inject({ method, url });
    assert.equal(r.statusCode, 401, `${method} ${url} without key`);
  }
});

test('thresholds round-trip: POST a partial -> GET reflects it (other field unchanged)', async () => {
  const before = (await app.inject({ method: 'GET', url: '/admin/chat/thresholds', headers: KEY })).json();
  const post = await app.inject({ method: 'POST', url: '/admin/chat/thresholds', headers: KEY, payload: { bigBetUsd: 1234 } });
  assert.equal(post.statusCode, 200, post.body);
  assert.equal(post.json().bigBetUsd, 1234);
  assert.equal(post.json().bigWinUsd, before.bigWinUsd); // partial update left the win threshold alone
  const get = await app.inject({ method: 'GET', url: '/admin/chat/thresholds', headers: KEY });
  assert.equal(get.json().bigBetUsd, 1234);
});

test('drop-config round-trip + the pot bucket reads 0 in Phase 1', async () => {
  const post = await app.inject({
    method: 'POST', url: '/admin/chat/drop-config', headers: KEY,
    payload: { intervalMin: 15, packTiers: [500, 250] },
  });
  assert.equal(post.statusCode, 200, post.body);
  assert.equal(post.json().intervalMin, 15);
  assert.deepEqual(post.json().packTiers, [250, 500]); // normalized server-side
  assert.ok(post.json().gdexMint, 'eligibility mint exposed read-only');

  const drop = await app.inject({ method: 'GET', url: '/admin/chat/drop', headers: KEY });
  assert.equal(drop.statusCode, 200);
  assert.equal(drop.json().bucketE6, '0');
  assert.deepEqual(drop.json().recentRounds, []);
  assert.equal(drop.json().totalTippedE6, '0'); // no tips yet
  assert.deepEqual(drop.json().recentTips, []);
});

test('invalid config is rejected with 400 (Zod)', async () => {
  const r = await app.inject({ method: 'POST', url: '/admin/chat/drop-config', headers: KEY, payload: { intervalMin: 0 } });
  assert.equal(r.statusCode, 400, r.body);
  const t = await app.inject({ method: 'POST', url: '/admin/chat/thresholds', headers: KEY, payload: { bigBetUsd: -1 } });
  assert.equal(t.statusCode, 400, t.body);
});

test('mod action resolves a wallet pubkey OR a user id; unknown -> 404', async () => {
  const pk = 'Wallet' + randomUUID().replace(/-/g, '').slice(0, 24);
  const uid = await newUser(pk);

  // grant by WALLET pubkey (the operator thinks in wallets)
  const grant = await app.inject({ method: 'POST', url: `/admin/chat/mods/${pk}`, headers: KEY, payload: { action: 'grant' } });
  assert.equal(grant.statusCode, 200, grant.body);
  assert.equal(grant.json().isMod, true);
  const mods = (await app.inject({ method: 'GET', url: '/admin/chat/mods', headers: KEY })).json();
  assert.ok(mods.mods.some((m: { userId: string }) => m.userId === uid), 'granted user appears in the mods list');

  // revoke by USER ID
  const revoke = await app.inject({ method: 'POST', url: `/admin/chat/mods/${uid}`, headers: KEY, payload: { action: 'revoke' } });
  assert.equal(revoke.statusCode, 200, revoke.body);
  assert.equal(revoke.json().isMod, false);

  // unmute + unban resolve too (a clear is a no-op when not muted/banned, but must succeed)
  for (const action of ['unmute', 'unban'] as const) {
    const r = await app.inject({ method: 'POST', url: `/admin/chat/mods/${uid}`, headers: KEY, payload: { action } });
    assert.equal(r.statusCode, 200, `${action}: ${r.body}`);
  }

  // an unknown identifier resolves to nobody -> 404
  const missing = await app.inject({ method: 'POST', url: '/admin/chat/mods/not-a-real-user', headers: KEY, payload: { action: 'grant' } });
  assert.equal(missing.statusCode, 404, missing.body);
});

test('a bad mod action value is rejected with 400', async () => {
  const uid = await newUser();
  const r = await app.inject({ method: 'POST', url: `/admin/chat/mods/${uid}`, headers: KEY, payload: { action: 'nope' } });
  assert.equal(r.statusCode, 400, r.body);
});
