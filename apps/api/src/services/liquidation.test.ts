import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.FEE_BPS = '10'; // this test's math assumes a 0.10% fee on open + close (default is now 0)

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { ingest } = await import('./oracle.ts');
const { fromPokemontcg } = await import('./providers/pokemontcg.ts');
const { listMarketsWithData } = await import('./markets.ts');
const { creditFaucet, getUserBalances } = await import('./faucet.ts');
const { openPosition, closePosition, liquidateEligible, liquidateAllEligible, getUserPositions } = await import('./engine.ts');
const { reconcile } = await import('./reconcile.ts');
const { allocateFeesToInsurance } = await import('./insurance.ts');
const { usdc } = await import('../money.ts');

await initDb();
const db = await getDb();
await ingest(db, async () => fromPokemontcg([
  { id: 'card-x', name: 'Test', number: '1', images: { small: 'x' }, tcgplayer: { prices: { holofoil: { market: 1000 } } } },
]));
const market = (await listMarketsWithData(db)).find((m) => m.symbol === 'card-x')!;

async function newUser(): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1, $2)`, [id, 'pk-' + id.slice(0, 8)]);
  await creditFaucet(db, id, 10_000);
  return id;
}
async function setMark(price: number): Promise<void> {
  const e6 = (BigInt(Math.round(price * 1000)) * 1000n).toString(); // price -> micro-USD
  await db.query(`INSERT INTO marks(market_id, mark_price_e6, index_price_e6) VALUES($1, $2, $2)`, [market.id, e6]);
}
async function insuranceBalance(): Promise<bigint> {
  const r = await db.query<{ a: string }>(
    `SELECT COALESCE(b.amount_uusdc,0)::text AS a FROM accounts a LEFT JOIN balances b ON b.account_id=a.id
     WHERE a.type='INSURANCE_FUND' AND a.user_id IS NULL`,
  );
  return BigInt(r.rows[0]?.a ?? '0');
}
async function feeRevenueBalance(): Promise<bigint> {
  const r = await db.query<{ a: string }>(
    `SELECT COALESCE(b.amount_uusdc,0)::text AS a FROM accounts a LEFT JOIN balances b ON b.account_id=a.id
     WHERE a.type='FEE_REVENUE' AND a.user_id IS NULL`,
  );
  return BigInt(r.rows[0]?.a ?? '0');
}
async function posStatus(userId: string): Promise<string | undefined> {
  const r = await db.query<{ s: string }>(`SELECT status AS s FROM positions WHERE user_id=$1 ORDER BY opened_at DESC LIMIT 1`, [userId]);
  return r.rows[0]?.s;
}

test('a 20x long is liquidated when the mark drops below maintenance margin', async () => {
  const trader = await newUser();
  // 5 units @ $1000 = $5000 notional, 20x => $250 margin; liq price = 1000*(1-0.05+0.025) = $975
  await openPosition(db, trader, { marketId: market.id, side: 'long', qtyE6: 5_000_000n, leverage: 20, idempotencyKey: randomUUID() });

  await setMark(970); // below the liq price
  const n = await liquidateEligible(db, market.id);
  assert.equal(n, 1);
  assert.equal(await posStatus(trader), 'liquidated');

  // loss = 5*($1000-$970) = $150; liq penalty = 1% of $4850 notional = $48.50, now split 60% LP / 40% house
  // (no longer 100% to insurance). House FEE_REVENUE = open-fee cut ($2.50) + liq-penalty cut ($19.40) = $21.90.
  assert.equal((await insuranceBalance()).toString(), '0', 'liq penalty no longer funds insurance');
  assert.equal((await feeRevenueBalance()).toString(), usdc(21.9).toString());
  // balance = 10000 - openFee($5) - loss($150) - liqFee($48.50) = $9796.50
  const b = await getUserBalances(db, trader);
  assert.equal(b.availableUusdc.toString(), usdc(9_796.5).toString());
  assert.equal(b.lockedMarginUusdc.toString(), '0');
});

test('a gap through the liq price creates bad debt, drawn from insurance then socialized to LP', async () => {
  const trader = await newUser();
  // mark is ~970 now; open a 20x long there, then gap to 900
  await openPosition(db, trader, { marketId: market.id, side: 'long', qtyE6: 5_000_000n, leverage: 20, idempotencyKey: randomUUID() });
  // The liq penalty no longer auto-funds insurance (it's split LP/house now), so seed the buffer with a
  // PARTIAL amount from house fee revenue — enough that the bad debt both draws it down AND socializes the
  // remainder to LP.
  await allocateFeesToInsurance(db, usdc(10));
  const insBefore = await insuranceBalance();

  await setMark(900);
  const n = await liquidateEligible(db, market.id);
  assert.equal(n, 1);
  assert.equal(await posStatus(trader), 'liquidated');

  const liq = await db.query<{ bad: string; drawn: string; soc: string }>(
    `SELECT bad_debt_uusdc::text AS bad, insurance_drawn_uusdc::text AS drawn, socialized_uusdc::text AS soc
     FROM liquidations WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [trader],
  );
  assert.ok(BigInt(liq.rows[0].bad) > 0n, 'bad debt recorded');
  assert.ok(BigInt(liq.rows[0].drawn) > 0n, 'insurance was drawn');
  assert.ok(BigInt(liq.rows[0].soc) > 0n, 'remainder socialized to LP');
  // insurance was drained by the draw
  assert.equal((await insuranceBalance()).toString(), (insBefore - BigInt(liq.rows[0].drawn)).toString());
});

test('a liquidatable position cannot be closed manually (must be liquidated)', async () => {
  const trader = await newUser();
  await setMark(1000);
  await openPosition(db, trader, { marketId: market.id, side: 'long', qtyE6: 5_000_000n, leverage: 20, idempotencyKey: randomUUID() });
  const [pos] = await getUserPositions(db, trader);
  await setMark(950); // below the ~$975 liq price
  await assert.rejects(
    closePosition(db, trader, { positionId: pos.id, fractionBps: 10_000, idempotencyKey: randomUUID() }),
    /liquidatable/,
  );
  await liquidateEligible(db, market.id); // cleanup: it goes through liquidation instead
});

test('liquidateAllEligible (admin "liquidate now") sweeps underwater positions across markets', async () => {
  const trader = await newUser();
  await openPosition(db, trader, { marketId: market.id, side: 'long', qtyE6: 5_000_000n, leverage: 20, idempotencyKey: randomUUID() });
  await setMark(900); // well below the ~$975 liq price
  const r = await liquidateAllEligible(db);
  assert.ok(r.liquidated >= 1, 'liquidated the underwater position');
  assert.ok(r.markets >= 1, 'scanned the live markets');
  assert.equal(await posStatus(trader), 'liquidated');
  await setMark(1000); // reset for the reconciler test
});

test('reconciler stays balanced after liquidations and bad debt', async () => {
  const report = await reconcile(db);
  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
});

after(async () => {
  await closeDb();
});
