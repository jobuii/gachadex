import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Real-funds + operator key: the /admin routes only exist with both. Chains are injected fakes.
process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.RATE_LIMIT_DISABLED = 'true';
process.env.REAL_FUNDS = 'true';
process.env.USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
process.env.TREASURY_PUBKEY = '11111111111111111111111111111111';
process.env.DEPOSIT_MASTER_SEED = 'ab'.repeat(32);
process.env.HOT_WALLET_SECRET = 'unused-in-tests-chain-is-injected';
process.env.ADMIN_API_KEY = 'test-admin-key-with-enough-entropy-123456';

const { buildServer } = await import('../server.ts');
const { initDb } = await import('../db/init.ts');
const { getDb, closeDb } = await import('../db/client.ts');
const { withdrawalsFrozen, unfreezeWithdrawals } = await import('./custody/treasury.ts');
const { usdc } = await import('../money.ts');
const { fund, fakeWithdrawChain, fakeTreasury } = await import('../test-helpers.ts');

await initDb();
const db = await getDb();
const wchain = fakeWithdrawChain();
const tchain = fakeTreasury({ hot: usdc(1_000), cold: usdc(1_000_000) });
const app = await buildServer({ adminChains: { withdrawChain: wchain, treasuryChain: tchain } });

const KEY = { 'x-admin-key': process.env.ADMIN_API_KEY };
const DEST = 'So11111111111111111111111111111111111111112';

async function newUserWithWithdrawal(amountE6: bigint): Promise<{ userId: string; wid: string }> {
  const userId = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1, $2)`, [userId, 'pk-' + userId.slice(0, 8)]);
  await fund(db, userId, amountE6 * 2n);
  const wid = randomUUID();
  await db.query(
    `INSERT INTO withdrawals(id, user_id, dest_address, amount_e6, status, idempotency_key)
     VALUES($1, $2, $3, $4, 'requested', $5)`,
    [wid, userId, DEST, amountE6.toString(), `adm-idem-${wid.slice(0, 8)}`],
  );
  return { userId, wid };
}

test('every /admin route requires the operator key', async () => {
  for (const [method, url] of [
    ['GET', '/admin/withdrawals'],
    ['POST', '/admin/withdrawals/x/approve'],
    ['POST', '/admin/withdrawals/x/reverse'],
    ['POST', '/admin/freeze'],
    ['POST', '/admin/unfreeze'],
    ['GET', '/admin/treasury'],
  ] as const) {
    const missing = await app.inject({ method, url });
    assert.equal(missing.statusCode, 401, `${method} ${url} without key`);
    const wrong = await app.inject({ method, url, headers: { 'x-admin-key': 'wrong-key-of-the-same-length-as-real-1234' } });
    assert.equal(wrong.statusCode, 401, `${method} ${url} with wrong key`);
  }
});

test('the queue lists requested withdrawals with the owner pubkey', async () => {
  const { userId, wid } = await newUserWithWithdrawal(usdc(5_000));
  const res = await app.inject({ method: 'GET', url: '/admin/withdrawals', headers: KEY });
  assert.equal(res.statusCode, 200, res.body);
  const row = res.json().withdrawals.find((w: { id: string }) => w.id === wid);
  assert.ok(row, 'queued withdrawal listed');
  assert.equal(row.pubkey, 'pk-' + userId.slice(0, 8));
  assert.equal(row.amount_e6, usdc(5_000).toString());
  assert.equal(res.json().frozen, null);
});

test('approve signs + broadcasts — explicitly above the auto-approve cap', async () => {
  const { wid } = await newUserWithWithdrawal(usdc(5_000)); // > $1k auto cap
  const res = await app.inject({ method: 'POST', url: `/admin/withdrawals/${wid}/approve`, headers: KEY });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().status, 'confirmed');
  const sig = wchain.signed.at(-1)!.sig;
  assert.ok(wchain.broadcasts.includes(sig));
  const row = (await db.query<{ status: string }>(`SELECT status FROM withdrawals WHERE id = $1`, [wid])).rows[0];
  assert.equal(row.status, 'confirmed');
});

test('reverse requires a reason and re-credits the row', async () => {
  const { wid } = await newUserWithWithdrawal(usdc(40));
  const noReason = await app.inject({ method: 'POST', url: `/admin/withdrawals/${wid}/reverse`, headers: KEY, payload: {} });
  assert.equal(noReason.statusCode, 400);
  const res = await app.inject({
    method: 'POST',
    url: `/admin/withdrawals/${wid}/reverse`,
    headers: KEY,
    payload: { reason: 'user requested cancellation' },
  });
  assert.equal(res.statusCode, 200, res.body);
  const row = (await db.query<{ status: string; reason: string }>(`SELECT status, reason FROM withdrawals WHERE id = $1`, [wid])).rows[0];
  assert.equal(row.status, 'reversed');
  assert.match(row.reason, /operator: user requested cancellation/);
});

test('manual freeze/unfreeze round-trips and is visible in the queue view', async () => {
  const freeze = await app.inject({ method: 'POST', url: '/admin/freeze', headers: KEY, payload: { reason: 'incident drill' } });
  assert.equal(freeze.statusCode, 200, freeze.body);
  assert.match((await withdrawalsFrozen(db)) ?? '', /operator: incident drill/);
  const queue = await app.inject({ method: 'GET', url: '/admin/withdrawals', headers: KEY });
  assert.match(queue.json().frozen ?? '', /incident drill/);

  const unfreeze = await app.inject({ method: 'POST', url: '/admin/unfreeze', headers: KEY });
  assert.equal(unfreeze.statusCode, 200, unfreeze.body);
  assert.equal(await withdrawalsFrozen(db), null);
});

test('the treasury report is read-only — numbers come back, nothing is swept or frozen', async () => {
  tchain.hot = usdc(100_000); // way above the float cap: a treasuryPass WOULD sweep this
  const before = tchain.sweeps.length;
  const res = await app.inject({ method: 'GET', url: '/admin/treasury', headers: KEY });
  assert.equal(res.statusCode, 200, res.body);
  const r = res.json();
  assert.equal(r.hotE6, usdc(100_000).toString());
  assert.equal(r.coldE6, usdc(1_000_000).toString());
  assert.equal(typeof r.liabilityE6, 'string');
  // every revenue figure must survive the route's field-by-field serialization (a missing field shows
  // as "—" in the admin panel — exactly the funding-box regression this guards against).
  for (const k of ['feeRevenueE6', 'fundingCollectedE6', 'fundingRevenueE6', 'insuranceE6', 'surplusE6']) {
    assert.equal(typeof r[k], 'string', `${k} present in the treasury response`);
  }
  assert.equal(r.breached, false);
  assert.equal(tchain.sweeps.length, before); // GET swept nothing
  assert.equal(await withdrawalsFrozen(db), null); // and froze nothing
});

after(async () => {
  await unfreezeWithdrawals(db);
  await app.close();
  await closeDb();
});
