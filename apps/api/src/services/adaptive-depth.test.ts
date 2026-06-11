import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// B' adaptive depth: depth = max(NAV, depthFloor, alpha*cumulativeVolume). Pin the knobs to their
// defaults so the mark math below is deterministic. The MAX_PNL_FACTOR gate stays OFF (unset) — this
// file exercises pricing/depth, not the risk gate.
process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.DEPTH_FLOOR_UUSDC = '1000000000000'; // $1M
process.env.DEPTH_ALPHA_E6 = '1000000'; // alpha = 1.0

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { ingest } = await import('./oracle.ts');
const { fromPokemontcg } = await import('./providers/pokemontcg.ts');
const { listMarketsWithData } = await import('./markets.ts');
const { creditFaucet } = await import('./faucet.ts');
const { openPosition, closePosition, getUserPositions } = await import('./engine.ts');
const { lpDeposit } = await import('./lp.ts');
const { reconcile } = await import('./reconcile.ts');
const { usdc } = await import('../money.ts');

await initDb();
const db = await getDb();

await ingest(db, async () => fromPokemontcg([
  { id: 'card-x', name: 'Test', number: '1', images: { small: 'x' }, tcgplayer: { prices: { holofoil: { market: 1000 } } } },
]));
const market = (await listMarketsWithData(db)).find((m) => m.symbol === 'card-x')!;

async function newUser(faucetUsd = 10_000): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1, $2)`, [id, 'pk-' + id.slice(0, 8)]);
  await creditFaucet(db, id, faucetUsd);
  return id;
}
const long5 = (userId: string) =>
  openPosition(db, userId, { marketId: market.id, side: 'long', qtyE6: 5_000_000n, leverage: 10, idempotencyKey: randomUUID() });
const cumVol = async (): Promise<bigint> =>
  BigInt((await db.query<{ v: string }>(`SELECT cumulative_volume_uusdc::text AS v FROM markets WHERE id=$1`, [market.id])).rows[0].v);
const setCumVol = (v: bigint) => db.query(`UPDATE markets SET cumulative_volume_uusdc=$1 WHERE id=$2`, [v.toString(), market.id]);

test('thin-pool gotcha is fixed: a $1k pool no longer pins the premium to its cap', async () => {
  // Seed a thin NAV = $1000. Pre-Phase-2 depth = NAV = $1k, so a $5k skew pinned the premium to its
  // ±10% cap (mark $1100). With the $1M floor, depth = $1M and the mark is the normal +0.5% -> $1005.
  await lpDeposit(db, await newUser(2_000), usdc(1_000));
  const trader = await newUser();
  await long5(trader);
  const [pos] = await getUserPositions(db, trader);
  assert.equal(pos.markE6, usdc(1_005).toString());
  await closePosition(db, trader, { positionId: pos.id, fractionBps: 10_000, idempotencyKey: randomUUID() });
});

test('a market deepens as cumulative volume grows: same skew, smaller premium', async () => {
  // Simulate a mature market. Set cumVol so that after THIS open adds its own $5k notional, the
  // counter is exactly $10M -> depth = alpha*$10M = $10M (10x the floor). A $5k skew then moves the
  // mark only +0.05% -> $1000.50, vs +0.5% -> $1005 on the fresh ($1M-floor) market above.
  await setCumVol(usdc(10_000_000) - usdc(5_000)); // +$5k from this open lands the counter at $10M
  const trader = await newUser();
  await long5(trader);
  const [pos] = await getUserPositions(db, trader);
  assert.equal(pos.markE6, (1_000_500_000n).toString()); // $1000.50 (+0.05%), premium cut ~10x vs the $1005 fresh mark
  assert.ok(BigInt(pos.markE6) < usdc(1_005), 'deeper market => smaller premium than the fresh market');
  await closePosition(db, trader, { positionId: pos.id, fractionBps: 10_000, idempotencyKey: randomUUID() });
});

test('cumulative volume accumulates traded notional on open and close', async () => {
  await setCumVol(0n);
  const trader = await newUser();
  await long5(trader); // opens $5k notional at the $1000 pre-trade mark
  const afterOpen = await cumVol();
  assert.equal(afterOpen, usdc(5_000), 'open records its $5k notional');
  const [pos] = await getUserPositions(db, trader);
  await closePosition(db, trader, { positionId: pos.id, fractionBps: 10_000, idempotencyKey: randomUUID() });
  assert.ok((await cumVol()) > afterOpen, 'close adds its notional on top');
});

test('reconciler stays balanced after adaptive-depth trading', async () => {
  const report = await reconcile(db);
  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
});

after(async () => {
  await closeDb();
});
