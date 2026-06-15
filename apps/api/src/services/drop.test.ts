import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.DROP_TIPS_ENABLED = 'true'; // exercise the tip path
process.env.DROP_TIP_MIN_USD = '1';
process.env.DROP_TIP_MAX_USD = '1000';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { tipDrop, dropPotE6, totalTippedE6, recentTips } = await import('./drop.ts');
const { getOrCreateUserAccount, getOrCreateSystemAccount, getBalance, postTxn } = await import('./ledger.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

const usdc = (d: number): bigint => BigInt(d * 1_000_000);

/** A fresh user with `uusdc` of spendable collateral (credited from the faucet source, balanced). */
async function newFundedUser(uusdc: bigint): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1, $2)`, [id, 'pk-' + id.slice(0, 8)]);
  await db.tx(async (q) => {
    const coll = await getOrCreateUserAccount(q, id, 'USER_COLLATERAL');
    const src = await getOrCreateSystemAccount(q, 'FAUCET_SOURCE');
    await postTxn(q, { reason: 'TEST_FUND', entries: [{ accountId: coll, amount: uusdc }, { accountId: src, amount: -uusdc }] });
  });
  return id;
}

test('tip moves collateral into the pot, records it, returns the new pot + balance', async () => {
  const u = await newFundedUser(usdc(100));
  const r = await tipDrop(db, u, usdc(25));
  assert.equal(r.amountE6, usdc(25).toString());
  assert.equal(r.balanceE6, usdc(75).toString()); // 100 - 25

  assert.equal((await dropPotE6(db)).toString(), usdc(25).toString());
  const coll = await getOrCreateUserAccount(db, u, 'USER_COLLATERAL');
  assert.equal((await getBalance(db, coll)).toString(), usdc(75).toString()); // collateral actually debited

  const tips = await recentTips(db);
  assert.ok(tips.some((t) => t.amountUusdc === usdc(25).toString()), 'tip recorded in recentTips');
});

test('a second tip accumulates the pot + lifetime total', async () => {
  const before = await dropPotE6(db);
  const u = await newFundedUser(usdc(50));
  await tipDrop(db, u, usdc(10));
  assert.equal((await dropPotE6(db)) - before, usdc(10));
  assert.equal((await totalTippedE6(db)).toString(), usdc(35).toString()); // 25 + 10
});

test('rejects below min, above max, and on insufficient balance (and the failed tip is not recorded)', async () => {
  const u = await newFundedUser(usdc(5));
  await assert.rejects(tipDrop(db, u, usdc(0.5)), /minimum/); // < $1
  await assert.rejects(tipDrop(db, u, usdc(2000)), /maximum/); // > $1000
  const potBefore = await dropPotE6(db);
  await assert.rejects(tipDrop(db, u, usdc(100)), /insufficient/); // only holds $5
  assert.equal((await dropPotE6(db)).toString(), potBefore.toString(), 'rolled back — pot unchanged');
});
