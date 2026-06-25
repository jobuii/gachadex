import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { getOrCreateSystemAccount, postTxn } = await import('./ledger.ts');
const { housePnlBreakdown, houseEconomics } = await import('./house-pnl.ts');
const { creditFaucet } = await import('./faucet.ts');
const { lpDeposit } = await import('./lp.ts');
const { usdc } = await import('../money.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

test('housePnlBreakdown decomposes house equity by source and the lines reconcile to the total', async () => {
  const lp = await getOrCreateSystemAccount(db, 'LP_POOL');
  const fee = await getOrCreateSystemAccount(db, 'FEE_REVENUE');
  const cp = await getOrCreateSystemAccount(db, 'TREASURY_USDC'); // dummy counterparty for the test legs

  const before = await housePnlBreakdown(db);
  // postTxn legs must commit together (the balance trigger is deferred to txn commit), so wrap in db.tx.
  await db.tx(async (q) => {
    // a $2 trading fee split 50/50 (house cut $1 to FEE_REVENUE, LP share $1 to LP_POOL)
    await postTxn(q, { reason: 'OPEN_FEE', refType: 'fee', refId: 'f1', entries: [
      { accountId: cp, amount: -usdc(2) }, { accountId: fee, amount: usdc(1) }, { accountId: lp, amount: usdc(1) },
    ] });
    // $3 funding to LP, $0.50 trader loss to LP (house gained), $0.25 liquidation penalty split 60/40 LP/house
    await postTxn(q, { reason: 'FUNDING', refType: 'position', refId: 'fn1', entries: [{ accountId: cp, amount: -usdc(3) }, { accountId: lp, amount: usdc(3) }] });
    await postTxn(q, { reason: 'REALIZED_PNL', refType: 'position', refId: 'p1', entries: [{ accountId: cp, amount: -usdc(0.5) }, { accountId: lp, amount: usdc(0.5) }] });
    await postTxn(q, { reason: 'LIQUIDATION_FEE', refType: 'liquidation', refId: 'l1', entries: [{ accountId: cp, amount: -usdc(0.25) }, { accountId: lp, amount: usdc(0.15) }, { accountId: fee, amount: usdc(0.1) }] });
  });

  const a = await housePnlBreakdown(db);
  const d = (k: keyof typeof a) => BigInt(a[k]) - BigInt(before[k]);
  assert.equal(d('feesHouseE6'), usdc(1.1), 'house fee cut $1 + liq-penalty house share $0.10');
  assert.equal(d('feesLpE6'), usdc(1), 'LP fee share');
  assert.equal(d('fundingNetE6'), usdc(3), 'funding net');
  assert.equal(d('traderPnlE6'), usdc(0.5), 'net trader P/L (house side)');
  assert.equal(d('liqPenaltiesE6'), usdc(0.25), 'total liquidation penalties (LP $0.15 + house $0.10)');
  assert.equal(d('insuranceE6'), usdc(0), 'insurance no longer funded by the liquidation penalty');
  assert.equal(d('totalE6'), usdc(5.75), 'total house equity delta = 1+1+3+0.5+0.25');

  // the displayed lines must sum EXACTLY to the total (the whole point of the card)
  const sum = BigInt(a.feesHouseE6) + BigInt(a.feesLpE6) + BigInt(a.fundingNetE6) + BigInt(a.traderPnlE6) + BigInt(a.lpOtherE6) + BigInt(a.insuranceE6);
  assert.equal(sum, BigInt(a.totalE6), 'fees(house+LP) + funding + traderPnl + lpOther + insurance = total');
});

test('houseEconomics is ledger-derived (no chain / no real-funds needed) and mirrors its sources', async () => {
  const before = await houseEconomics(db);
  // a fresh customer funds $1000 and moves $200 into the LP pool — pure ledger activity
  const u = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1, $2)`, [u, 'pk-econ-' + u.slice(0, 8)]);
  await creditFaucet(db, u, 1000);
  await lpDeposit(db, u, usdc(200));
  const after = await houseEconomics(db);

  // free collateral rose by exactly $800 ($1000 faucet − $200 into the pool)
  assert.equal(BigInt(after.freeE6) - BigInt(before.freeE6), usdc(800));
  // customer LP value reflects the new $200 stake
  assert.ok(BigInt(after.customerLpE6) - BigInt(before.customerLpE6) >= usdc(200) - 5n, 'LP value reflects the deposit');
  // the economics fields are the single source of truth shared with the P/L breakdown
  assert.equal(after.feeRevenueE6, after.pnlBreakdown.feesHouseE6);
  assert.equal(after.fundingRevenueE6, after.pnlBreakdown.fundingNetE6);
  assert.equal(after.insuranceE6, after.pnlBreakdown.insuranceE6);
  // gross funding collected is never below net kept (net = gross − funding paid back out)
  assert.ok(BigInt(after.fundingCollectedE6) >= BigInt(after.fundingRevenueE6));
  assert.equal(typeof after.pnlBreakdown.totalE6, 'string');
});
