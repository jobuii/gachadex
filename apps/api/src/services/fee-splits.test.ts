import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Verifies the LP revenue-share split for FUNDING (the riskiest of the three knobs — it's bidirectional, so
// the house must share both inflows and outflows). Trading-fee (50/50) and liquidation (60/40) splits are
// covered by house-pnl.test.ts and liquidation.test.ts respectively.

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { settlePositionFunding } = await import('./funding.ts');
const { getLpFundingPct } = await import('./fees.ts');
const { creditFaucet } = await import('./faucet.ts');
const { reconcile } = await import('./reconcile.ts');

await initDb();
const db = await getDb();
const MARKET = 'fee-split-mkt';

async function sysBal(type: string): Promise<bigint> {
  const r = await db.query<{ a: string }>(
    `SELECT COALESCE(b.amount_uusdc,0)::text AS a FROM accounts a LEFT JOIN balances b ON b.account_id=a.id
     WHERE a.type=$1 AND a.user_id IS NULL`,
    [type],
  );
  return BigInt(r.rows[0]?.a ?? '0');
}
async function userColl(userId: string): Promise<bigint> {
  const r = await db.query<{ a: string }>(
    `SELECT COALESCE(b.amount_uusdc,0)::text AS a FROM accounts a LEFT JOIN balances b ON b.account_id=a.id
     WHERE a.type='USER_COLLATERAL' AND a.user_id=$1`,
    [userId],
  );
  return BigInt(r.rows[0]?.a ?? '0');
}
async function newTrader(): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1,$2)`, [id, 'pk-' + id.slice(0, 8)]);
  await creditFaucet(db, id, 10_000);
  return id;
}
// A +1% cumulative funding index on the market (1e4 of a 1e6 fraction). settlePositionFunding settles a
// position's snapshot (0) against this, so a long PAYS and a short RECEIVES the same magnitude.
async function setFundingIndex(): Promise<void> {
  await db.query(
    `INSERT INTO markets(id, kind, symbol, display_name) VALUES($1, 'card', $1, 'Fee Split Test')
     ON CONFLICT (id) DO NOTHING`,
    [MARKET],
  );
  await db.query(
    `INSERT INTO funding_rates(market_id, interval_start, interval_end, rate_e6, skew_uusdc, cumulative_index_e6)
     VALUES($1, now(), now(), $2, 0, $2)`,
    [MARKET, '10000'],
  );
}
const fundable = (userId: string, side: 'long' | 'short') => ({
  id: randomUUID(),
  user_id: userId,
  side,
  qty_e6: '5000000', // 5 units
  avg_entry_e6: '1000000000', // $1000
  funding_index_snapshot_e6: '0',
});

test('funding LP share defaults to 80%', () => {
  assert.equal(getLpFundingPct(), 80);
});

test('a long PAYING funding splits 80% LP / 20% house, and conserves value', async () => {
  await setFundingIndex();
  const trader = await newTrader();
  const lp0 = await sysBal('LP_POOL');
  const rev0 = await sysBal('FEE_REVENUE');
  const coll0 = await userColl(trader);

  await db.tx((q) => settlePositionFunding(q, fundable(trader, 'long'), MARKET));

  const lpGain = (await sysBal('LP_POOL')) - lp0;
  const houseGain = (await sysBal('FEE_REVENUE')) - rev0;
  const traderPaid = coll0 - (await userColl(trader));
  assert.ok(traderPaid > 0n, 'the long paid funding');
  assert.equal((lpGain + houseGain).toString(), traderPaid.toString(), 'funding conserved (LP + house = paid)');
  assert.equal(lpGain.toString(), ((traderPaid * 80n) / 100n).toString(), 'LP gets 80%');
  assert.equal(houseGain.toString(), (traderPaid - (traderPaid * 80n) / 100n).toString(), 'house gets the rest');
});

test('a short RECEIVING funding is paid 80% by LP / 20% by house (outflow shared too)', async () => {
  const trader = await newTrader();
  const lp0 = await sysBal('LP_POOL');
  const rev0 = await sysBal('FEE_REVENUE');
  const coll0 = await userColl(trader);

  await db.tx((q) => settlePositionFunding(q, fundable(trader, 'short'), MARKET));

  const lpPaid = lp0 - (await sysBal('LP_POOL'));
  const housePaid = rev0 - (await sysBal('FEE_REVENUE'));
  const traderGot = (await userColl(trader)) - coll0;
  assert.ok(traderGot > 0n, 'the short received funding');
  assert.equal((lpPaid + housePaid).toString(), traderGot.toString(), 'funding conserved (LP + house = received)');
  assert.equal(lpPaid.toString(), ((traderGot * 80n) / 100n).toString(), 'LP pays 80% of the outflow');
});

test('reconciler stays balanced after split funding', async () => {
  const report = await reconcile(db);
  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
});

after(async () => {
  await closeDb();
});
