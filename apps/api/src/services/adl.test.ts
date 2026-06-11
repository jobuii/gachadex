import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Auto-deleverage (Phase 3). Enable ADL at 20% of NAV; leave the MAX_PNL_FACTOR open-gate OFF so we
// can build up a winning position freely and watch ADL shed it. Depth knobs pinned to defaults.
process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.ADL_PNL_FACTOR_BPS = '2000'; // 20%
process.env.DEPTH_FLOOR_UUSDC = '1000000000000';
process.env.DEPTH_ALPHA_E6 = '1000000';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { ingest } = await import('./oracle.ts');
const { fromPokemontcg } = await import('./providers/pokemontcg.ts');
const { listMarketsWithData } = await import('./markets.ts');
const { creditFaucet, getUserBalances } = await import('./faucet.ts');
const { openPosition, closePosition, getUserPositions, autoDeleverage } = await import('./engine.ts');
const { lpDeposit, getPool } = await import('./lp.ts');
const { getPositionHistory } = await import('./history.ts');
const { reconcile } = await import('./reconcile.ts');
const { usdc } = await import('../money.ts');

await initDb();
const db = await getDb();

const card = (price: number) => [
  { id: 'card-x', name: 'Test', number: '1', images: { small: 'x' }, tcgplayer: { prices: { holofoil: { market: price } } } },
];
await ingest(db, async () => fromPokemontcg(card(1000)));
const market = (await listMarketsWithData(db)).find((m) => m.symbol === 'card-x')!;

async function newUser(faucetUsd = 10_000): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1, $2)`, [id, 'pk-' + id.slice(0, 8)]);
  await creditFaucet(db, id, faucetUsd);
  return id;
}
const openLong = (userId: string, qtyE6: bigint) =>
  openPosition(db, userId, { marketId: market.id, side: 'long', qtyE6, leverage: 10, idempotencyKey: randomUUID() });
const bumpPrice = (price: number) => ingest(db, async () => fromPokemontcg(card(price)));
async function closeAll(userId: string): Promise<void> {
  for (const p of await getUserPositions(db, userId)) {
    await closePosition(db, userId, { positionId: p.id, fractionBps: 10_000, idempotencyKey: randomUUID() });
  }
}

// Seed a healthy pool: NAV = $10,000 -> ADL target = 20% = $2,000.
await lpDeposit(db, await newUser(20_000), usdc(10_000));

test('ADL is a no-op while pool liability stays under the threshold', async () => {
  const a = await newUser();
  await openLong(a, 10_000_000n); // 10 units
  await bumpPrice(1_050); // uPnL = 10 * ($1050-$1000) = $500, well under the $2,000 target
  assert.equal(await autoDeleverage(db), 0);
  assert.equal((await getUserPositions(db, a))[0].status, 'open');
  await closeAll(a); // cleanup
  await bumpPrice(1_000); // reset index
});

test('ADL force-closes the most profitable position once liability tops the threshold', async () => {
  const navBefore = BigInt((await getPool(db)).navUusdc);
  const trader = await newUser();
  const balBefore = (await getUserBalances(db, trader)).availableUusdc; // $10k faucet
  await openLong(trader, 30_000_000n); // 30 units, $30k notional, 10x -> $3k margin
  await bumpPrice(1_100); // uPnL = 30 * $100 = $3,000 > $2,000 target

  const closed = await autoDeleverage(db);
  assert.ok(closed >= 1, 'at least one position was deleveraged');

  const row = await db.query<{ status: string }>(`SELECT status FROM positions WHERE user_id=$1`, [trader]);
  assert.equal(row.rows[0].status, 'deleveraged');
  assert.equal((await getUserPositions(db, trader)).length, 0); // nothing left open

  // trader keeps the win: margin returned ($3k) + realized profit ($3k), no fee/penalty
  const balAfter = (await getUserBalances(db, trader)).availableUusdc;
  assert.equal(balAfter.toString(), (balBefore + usdc(3_000)).toString());
  // the LP pool funded that $3k payout
  assert.equal((await getPool(db)).navUusdc, (navBefore - usdc(3_000)).toString());
  // and the force-closed position still shows up in the trader's history (not silently dropped)
  const hist = await getPositionHistory(db, trader);
  assert.ok(hist.some((h) => h.status === 'deleveraged'), 'ADL close appears in trade history');
});

test('reconciler stays balanced after ADL', async () => {
  const report = await reconcile(db);
  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
});

after(async () => {
  await closeDb();
});
