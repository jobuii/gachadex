import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { lpDeposit } = await import('./lp.ts');
const { creditFaucet } = await import('./faucet.ts');
const { getOrCreateSystemAccount, getOrCreateUserAccount, postTxn } = await import('./ledger.ts');
const { computePoolSnapshot, setPoolSnapshot, getPoolSnapshot } = await import('./pool-snapshot.ts');
const { usdc } = await import('../money.ts');

await initDb();
const db = await getDb();

test('snapshot: default shares 50/80/60, NAV gain = NAV − net deposits, publish/read round-trips', async () => {
  const u = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1,$2)`, [u, 'pk-' + u.slice(0, 8)]);
  await creditFaucet(db, u, 5_000);
  await lpDeposit(db, u, usdc(1_000)); // net LP deposits = $1000, pool NAV (ledger) = $1000, gain = $0

  // simulate $100 of pool earnings (a trader loss flowing into the pool)
  await db.tx(async (q) => {
    const lp = await getOrCreateSystemAccount(q, 'LP_POOL');
    const coll = await getOrCreateUserAccount(q, u, 'USER_COLLATERAL');
    await postTxn(q, {
      reason: 'REALIZED_PNL',
      entries: [
        { accountId: coll, amount: -usdc(100) },
        { accountId: lp, amount: usdc(100) },
      ],
    });
  });

  const snap = await computePoolSnapshot(db);
  assert.equal(snap.lpTradingPct, 50);
  assert.equal(snap.lpFundingPct, 80);
  assert.equal(snap.lpLiquidationPct, 60);
  assert.equal(snap.totalFeesEarnedE6, usdc(100).toString(), 'NAV gain = $1100 ledger − $1000 deposits = $100');

  // not published until "Refresh pool numbers"
  assert.equal(await getPoolSnapshot(db), null);
  const published = await setPoolSnapshot(db);
  const got = await getPoolSnapshot(db);
  assert.equal(got!.totalFeesEarnedE6, published.totalFeesEarnedE6);
  assert.equal(got!.lpFundingPct, 80);
});

after(async () => {
  await closeDb();
});
