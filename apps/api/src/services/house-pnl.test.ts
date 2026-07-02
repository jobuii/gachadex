import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { getOrCreateSystemAccount, getOrCreateUserAccount, postTxn } = await import('./ledger.ts');
const { housePnlBreakdown, houseEconomics } = await import('./house-pnl.ts');
const { creditFaucet } = await import('./faucet.ts');
const { lpDeposit } = await import('./lp.ts');
const { usdc } = await import('../money.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

test('housePnlBreakdown: house earnings sum to the surplus; the LP side sums to the LP pool', async () => {
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
    // $3.20 funding split: $3 to the LP pool + $0.20 house cut to FEE_REVENUE
    await postTxn(q, { reason: 'FUNDING', refType: 'position', refId: 'fn1', entries: [
      { accountId: cp, amount: -usdc(3.2) }, { accountId: lp, amount: usdc(3) }, { accountId: fee, amount: usdc(0.2) },
    ] });
    // a gacha sell-back cut of $0.40 to FEE_REVENUE
    await postTxn(q, { reason: 'GACHA_SELLBACK', refType: 'gacha', refId: 'g1', entries: [{ accountId: cp, amount: -usdc(0.4) }, { accountId: fee, amount: usdc(0.4) }] });
    // $0.50 trader loss to LP (LP gained), $0.25 liquidation penalty split 60/40 LP/house
    await postTxn(q, { reason: 'REALIZED_PNL', refType: 'position', refId: 'p1', entries: [{ accountId: cp, amount: -usdc(0.5) }, { accountId: lp, amount: usdc(0.5) }] });
    await postTxn(q, { reason: 'LIQUIDATION_FEE', refType: 'liquidation', refId: 'l1', entries: [{ accountId: cp, amount: -usdc(0.25) }, { accountId: lp, amount: usdc(0.15) }, { accountId: fee, amount: usdc(0.1) }] });
  });

  const a = await housePnlBreakdown(db);
  const d = (k: keyof typeof a) => BigInt(a[k]) - BigInt(before[k]);
  // House earnings — FEE_REVENUE decomposed by source.
  assert.equal(d('feesTradingE6'), usdc(1), 'trading-fee house cut $1');
  assert.equal(d('feesGachaE6'), usdc(0.4), 'gacha sell-back cut $0.40');
  assert.equal(d('fundingHouseE6'), usdc(0.2), 'funding house cut $0.20 (FEE_REVENUE leg)');
  assert.equal(d('liqHouseE6'), usdc(0.1), 'liq-penalty house share $0.10');
  assert.equal(d('feesOtherE6'), usdc(0), 'no insurance moves — remainder is zero');
  assert.equal(d('surplusE6'), usdc(1.7), 'surplus = FEE_REVENUE delta = 1 + 0.4 + 0.2 + 0.1');
  // LP side — owed to LP providers, not house P/L.
  assert.equal(d('feesLpE6'), usdc(1), 'LP fee share');
  assert.equal(d('fundingLpE6'), usdc(3), 'funding paid into the LP pool (FUNDING leg on LP_POOL)');
  assert.equal(d('traderPnlE6'), usdc(0.5), 'net trader P/L absorbed by the LP pool');
  assert.equal(d('lpOtherE6'), usdc(0.15), 'liq-penalty LP share $0.15 (LP remainder)');
  assert.equal(d('lpPoolE6'), usdc(4.65), 'LP pool delta = 1 + 3 + 0.5 + 0.15');
  assert.equal(d('liqPenaltiesE6'), usdc(0.25), 'total liquidation penalties (LP $0.15 + house $0.10)');
  assert.equal(d('insuranceE6'), usdc(0), 'insurance not funded by the liquidation penalty');

  // House-earning lines must sum EXACTLY to the surplus (the whole point of the card).
  const houseSum = BigInt(a.feesTradingE6) + BigInt(a.feesGachaE6) + BigInt(a.fundingHouseE6) + BigInt(a.liqHouseE6) + BigInt(a.bonusCreditedE6) + BigInt(a.feesOtherE6);
  assert.equal(houseSum, BigInt(a.surplusE6), 'trading + gacha + funding + liq + bonus + other = surplus');
  // LP-side lines must sum EXACTLY to the LP pool balance.
  const lpSum = BigInt(a.feesLpE6) + BigInt(a.fundingLpE6) + BigInt(a.traderPnlE6) + BigInt(a.lpOtherE6);
  assert.equal(lpSum, BigInt(a.lpPoolE6), 'LP fees + LP funding + trader P/L + LP capital = LP pool balance');
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
  assert.equal(after.surplusE6, after.pnlBreakdown.surplusE6);
  assert.equal(after.feeRevenueE6, after.pnlBreakdown.surplusE6); // feeRevenueE6 is an alias of the surplus
  assert.equal(after.fundingHouseE6, after.pnlBreakdown.fundingHouseE6);
  assert.equal(after.fundingLpE6, after.pnlBreakdown.fundingLpE6);
  assert.equal(after.insuranceE6, after.pnlBreakdown.insuranceE6);
  // gross funding into the pool is never below the net LP share (net = gross − funding paid back out)
  assert.ok(BigInt(after.fundingCollectedE6) >= BigInt(after.fundingLpE6));
  assert.equal(typeof after.pnlBreakdown.surplusE6, 'string');
});

test('houseEconomics: gacha net (house) = narrow revenue − Gold rebate − gacha referral; referral fees paid = perps + gacha', async () => {
  const fee = await getOrCreateSystemAccount(db, 'FEE_REVENUE');
  const budget = await getOrCreateSystemAccount(db, 'GACHA_REWARDS_BUDGET');
  const cp = await getOrCreateSystemAccount(db, 'TREASURY_USDC'); // dummy counterparty for the test legs
  const before = await houseEconomics(db);
  await db.tx(async (q) => {
    // $2 gacha house revenue (sell-back cut) to FEE_REVENUE
    await postTxn(q, { reason: 'GACHA_SELLBACK', refType: 'gacha', refId: 'he-g1', entries: [{ accountId: cp, amount: -usdc(2) }, { accountId: fee, amount: usdc(2) }] });
    // fund the rewards budget $0.50 from fees, then draw it to fund a Gold pack (the Gold rebate cost)
    await postTxn(q, { reason: 'GACHA_REWARDS_FUND', refType: 'admin', refId: 'he-g2', entries: [{ accountId: fee, amount: -usdc(0.5) }, { accountId: budget, amount: usdc(0.5) }] });
    await postTxn(q, { reason: 'PACK_BUY_GOLD_FUND', refType: 'gacha_open', refId: 'he-g3', entries: [{ accountId: budget, amount: -usdc(0.5) }, { accountId: cp, amount: usdc(0.5) }] });
    // referral payouts out of FEE_REVENUE: gacha share $0.30 + perps cashback $0.20
    await postTxn(q, { reason: 'GAME_REVENUE_SHARE', refType: 'gacha', refId: 'he-g4', entries: [{ accountId: fee, amount: -usdc(0.3) }, { accountId: cp, amount: usdc(0.3) }] });
    await postTxn(q, { reason: 'REFERRAL_CASHBACK', refType: 'fee', refId: 'he-g5', entries: [{ accountId: fee, amount: -usdc(0.2) }, { accountId: cp, amount: usdc(0.2) }] });
  });
  const after = await houseEconomics(db);
  // gacha net Δ = revenue $2 − Gold rebate $0.50 − gacha referral $0.30 = $1.20 (the GACHA_REWARDS_FUND top-up is NOT double-counted)
  assert.equal(BigInt(after.gachaNetE6) - BigInt(before.gachaNetE6), usdc(1.2), 'gacha net = narrow revenue − Gold rebate − gacha referral');
  // referral fees paid Δ = gacha $0.30 + perps $0.20 = $0.50
  assert.equal(BigInt(after.referralFeesPaidE6) - BigInt(before.referralFeesPaidE6), usdc(0.5), 'referral paid = perps + gacha payouts');
});

test('housePnlBreakdown: gacha earnings net the ACTUAL Gold spent; the UNUSED rewards-budget funding lands in Other', async () => {
  const fee = await getOrCreateSystemAccount(db, 'FEE_REVENUE');
  const budget = await getOrCreateSystemAccount(db, 'GACHA_REWARDS_BUDGET');
  const cp = await getOrCreateSystemAccount(db, 'TREASURY_USDC'); // dummy counterparty
  const before = await housePnlBreakdown(db);
  await db.tx(async (q) => {
    // $10 gacha sell-back cut → gacha fee income
    await postTxn(q, { reason: 'GACHA_SELLBACK', refType: 'gacha', refId: 'hp-g1', entries: [{ accountId: cp, amount: -usdc(10) }, { accountId: fee, amount: usdc(10) }] });
    // fund the rewards budget with $4 from fees (a reserve top-up — NOT a gacha cut)
    await postTxn(q, { reason: 'GACHA_REWARDS_FUND', refType: 'admin', refId: 'hp-g2', entries: [{ accountId: fee, amount: -usdc(4) }, { accountId: budget, amount: usdc(4) }] });
    // spend $3 of it on a Gold pack (the actual Gold cost); $1 stays UNUSED in the budget
    await postTxn(q, { reason: 'PACK_BUY_GOLD_FUND', refType: 'gacha_open', refId: 'hp-g3', entries: [{ accountId: budget, amount: -usdc(3) }, { accountId: cp, amount: usdc(3) }] });
  });
  const after = await housePnlBreakdown(db);
  const d = (k: keyof typeof after) => BigInt(after[k]) - BigInt(before[k]);
  assert.equal(d('feesGachaE6'), usdc(7), 'gacha net = $10 fee income − $3 ACTUAL Gold spend (not the $4 funding)');
  assert.equal(d('feesOtherE6'), -usdc(1), 'the $1 UNUSED rewards-budget funding falls into Other');
  assert.equal(d('surplusE6'), usdc(6), 'surplus rose by fee income minus the budget top-up ($10 − $4)');
  assert.equal(d('feesTradingE6') + d('feesGachaE6') + d('fundingHouseE6') + d('liqHouseE6') + d('bonusCreditedE6') + d('feesOtherE6'), d('surplusE6'), 'the six lines still sum to surplus');
});

test('housePnlBreakdown: bonus credits ISSUED are their own house-cost line; the UNUSED credit budget stays in Other', async () => {
  const fee = await getOrCreateSystemAccount(db, 'FEE_REVENUE');
  const budget = await getOrCreateSystemAccount(db, 'CREDIT_BUDGET');
  const cp = await getOrCreateSystemAccount(db, 'TREASURY_USDC'); // dummy counterparty
  const user = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1, $2)`, [user, 'pk-' + user.slice(0, 8)]);
  const before = await housePnlBreakdown(db);
  await db.tx(async (q) => {
    // fund the credit budget with $8 from fees (a reserve top-up — NOT a house cut yet)
    await postTxn(q, { reason: 'CREDIT_BUDGET_FUND', refType: 'admin', refId: 'hp-b1', entries: [{ accountId: fee, amount: -usdc(8) }, { accountId: budget, amount: usdc(8) }] });
    // ISSUE a $3 signup bonus to a customer ($5 stays UNUSED in the budget)
    const coll = await getOrCreateUserAccount(q, user, 'USER_COLLATERAL');
    await postTxn(q, { reason: 'SIGNUP_BONUS', refType: 'bonus', refId: 'hp-b2', entries: [{ accountId: budget, amount: -usdc(3) }, { accountId: coll, amount: usdc(3) }] });
  });
  const after = await housePnlBreakdown(db);
  const d = (k: keyof typeof after) => BigInt(after[k]) - BigInt(before[k]);
  assert.equal(d('bonusCreditedE6'), -usdc(3), 'the $3 issued bonus is its own debit line');
  assert.equal(d('feesOtherE6'), -usdc(5), 'the $5 UNUSED credit-budget funding stays in Other');
  assert.equal(d('surplusE6'), -usdc(8), 'surplus fell by the $8 budget top-up (fees → reserve)');
  assert.equal(d('feesTradingE6') + d('feesGachaE6') + d('fundingHouseE6') + d('liqHouseE6') + d('bonusCreditedE6') + d('feesOtherE6'), d('surplusE6'), 'the six lines still sum to surplus');
});
