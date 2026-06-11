import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { ingest } = await import('./oracle.ts');
const { fromPokemontcg } = await import('./providers/pokemontcg.ts');
const { listMarketsWithData } = await import('./markets.ts');
const { creditFaucet, getUserBalances } = await import('./faucet.ts');
const { openPosition, closePosition, getUserPositions } = await import('./engine.ts');
const { lpDeposit, lpWithdraw, getPool, getLpPosition } = await import('./lp.ts');
const { accrueFunding } = await import('./funding.ts');
const { reconcile } = await import('./reconcile.ts');
const { usdc } = await import('../money.ts');

await initDb();
const db = await getDb();
await ingest(db, async () => fromPokemontcg([
  { id: 'card-x', name: 'Test', number: '1', images: { small: 'x' }, tcgplayer: { prices: { holofoil: { market: 1000 } } } },
]));
const market = (await listMarketsWithData(db)).find((m) => m.symbol === 'card-x')!;

async function newUser(fund = 10_000): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1, $2)`, [id, 'pk-' + id.slice(0, 8)]);
  await creditFaucet(db, id, fund);
  return id;
}

const lpUser = await newUser(500_000);

test('LP deposit mints shares at par and is reflected in the pool', async () => {
  const r = await lpDeposit(db, lpUser, usdc(500_000));
  assert.equal(r.sharesMinted, usdc(500_000).toString()); // bootstrap: 1 share == 1 micro-USDC
  const pool = await getPool(db);
  assert.equal(pool.navUusdc, usdc(500_000).toString());
  assert.equal(pool.sharePriceE6, '1000000'); // $1.00 per share
  const pos = await getLpPosition(db, lpUser);
  assert.equal(pos.valueUusdc, usdc(500_000).toString());
});

test('withdrawal is blocked while capital backs an open trade', async () => {
  const trader = await newUser();
  await openPosition(db, trader, { marketId: market.id, side: 'long', qtyE6: 5_000_000n, leverage: 10, idempotencyKey: randomUUID() });
  const pool = await getPool(db);
  await assert.rejects(lpWithdraw(db, lpUser, BigInt(pool.totalShares)), /capital backing/);
});

test('NAV absorbs trader PnL; LP can withdraw after the trade closes', async () => {
  // close the open trade (the long is profitable as its own skew lifted the mark)
  for (const t of await db.query<{ user_id: string; id: string }>(`SELECT user_id, id FROM positions WHERE status='open'`).then((r) => r.rows)) {
    await closePosition(db, t.user_id, { positionId: t.id, fractionBps: 10_000, idempotencyKey: randomUUID() });
  }
  const pool = await getPool(db);
  // LP paid out the winning trader, so NAV dipped below the deposited $500k (but not by much)
  assert.ok(BigInt(pool.navUusdc) < usdc(500_000), 'NAV decreased after paying the trader');
  assert.ok(BigInt(pool.navUusdc) > usdc(499_000), `NAV still near deposit, got ${pool.navUusdc}`);

  const before = await getLpPosition(db, lpUser);
  const w = await lpWithdraw(db, lpUser, BigInt(before.shares));
  assert.ok(BigInt(w.payoutUusdc) > 0n);
  const after = await getLpPosition(db, lpUser);
  assert.equal(after.shares, '0');
});

test('funding charges the heavy (long) side', async () => {
  const trader = await newUser();
  await openPosition(db, trader, { marketId: market.id, side: 'long', qtyE6: 5_000_000n, leverage: 10, idempotencyKey: randomUUID() });
  // all open interest is long -> skew ratio 1 -> +30bps -> cumulative 0.003
  await accrueFunding(db, market.id);
  const [pos] = await getUserPositions(db, trader);
  await closePosition(db, trader, { positionId: pos.id, fractionBps: 10_000, idempotencyKey: randomUUID() });

  // funding paid by the long = notional($5000) * 0.003 = $15
  const r = await db.query<{ s: string }>(
    `SELECT COALESCE(SUM(le.amount_uusdc),0)::text AS s
     FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
     WHERE a.user_id=$1 AND a.type='USER_COLLATERAL' AND le.reason='FUNDING'`,
    [trader],
  );
  assert.equal(r.rows[0].s, (-usdc(15)).toString());
});

test('faucet clamps the available balance to the cap', async () => {
  const u = await newUser(); // starts at $10k
  await creditFaucet(db, u, 990_000); // -> exactly the $1,000,000 cap
  assert.equal((await getUserBalances(db, u)).availableUusdc.toString(), usdc(1_000_000).toString());
  await assert.rejects(creditFaucet(db, u, 1), /faucet limit/); // can't exceed the cap
});

test('reconciler stays balanced after LP + funding activity', async () => {
  const report = await reconcile(db);
  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
});

after(async () => {
  await closeDb();
});
