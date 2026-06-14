import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { getOrCreateSystemAccount, postTxn } = await import('./ledger.ts');
const { housePnlBreakdown } = await import('./house-pnl.ts');
const { usdc } = await import('../money.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

test('housePnlBreakdown decomposes house equity by source and the lines reconcile to the total', async () => {
  const lp = await getOrCreateSystemAccount(db, 'LP_POOL');
  const fee = await getOrCreateSystemAccount(db, 'FEE_REVENUE');
  const ins = await getOrCreateSystemAccount(db, 'INSURANCE_FUND');
  const cp = await getOrCreateSystemAccount(db, 'TREASURY_USDC'); // dummy counterparty for the test legs

  const before = await housePnlBreakdown(db);
  // postTxn legs must commit together (the balance trigger is deferred to txn commit), so wrap in db.tx.
  await db.tx(async (q) => {
    // a $2 trading fee split 50/50 (house cut $1 to FEE_REVENUE, LP share $1 to LP_POOL)
    await postTxn(q, { reason: 'OPEN_FEE', refType: 'fee', refId: 'f1', entries: [
      { accountId: cp, amount: -usdc(2) }, { accountId: fee, amount: usdc(1) }, { accountId: lp, amount: usdc(1) },
    ] });
    // $3 funding to LP, $0.50 trader loss to LP (house gained), $0.25 liquidation penalty to insurance
    await postTxn(q, { reason: 'FUNDING', refType: 'position', refId: 'fn1', entries: [{ accountId: cp, amount: -usdc(3) }, { accountId: lp, amount: usdc(3) }] });
    await postTxn(q, { reason: 'REALIZED_PNL', refType: 'position', refId: 'p1', entries: [{ accountId: cp, amount: -usdc(0.5) }, { accountId: lp, amount: usdc(0.5) }] });
    await postTxn(q, { reason: 'LIQUIDATION_FEE', refType: 'liquidation', refId: 'l1', entries: [{ accountId: cp, amount: -usdc(0.25) }, { accountId: ins, amount: usdc(0.25) }] });
  });

  const a = await housePnlBreakdown(db);
  const d = (k: keyof typeof a) => BigInt(a[k]) - BigInt(before[k]);
  assert.equal(d('feesHouseE6'), usdc(1), 'house fee cut');
  assert.equal(d('feesLpE6'), usdc(1), 'LP fee share');
  assert.equal(d('fundingNetE6'), usdc(3), 'funding net');
  assert.equal(d('traderPnlE6'), usdc(0.5), 'net trader P/L (house side)');
  assert.equal(d('liqPenaltiesE6'), usdc(0.25), 'liquidation penalties');
  assert.equal(d('insuranceE6'), usdc(0.25), 'insurance fund balance');
  assert.equal(d('totalE6'), usdc(5.75), 'total house equity delta = 1+1+3+0.5+0.25');

  // the displayed lines must sum EXACTLY to the total (the whole point of the card)
  const sum = BigInt(a.feesHouseE6) + BigInt(a.feesLpE6) + BigInt(a.fundingNetE6) + BigInt(a.traderPnlE6) + BigInt(a.lpOtherE6) + BigInt(a.insuranceE6);
  assert.equal(sum, BigInt(a.totalE6), 'fees(house+LP) + funding + traderPnl + lpOther + insurance = total');
});
