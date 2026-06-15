import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.FEE_BPS = '10'; // exercise the commission path (default is now 0); charged on open + close

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { ingest } = await import('./oracle.ts');
const { fromPokemontcg } = await import('./providers/pokemontcg.ts');
const { listMarketsWithData } = await import('./markets.ts');
const { creditFaucet, getUserBalances } = await import('./faucet.ts');
const { openPosition, closePosition, getUserPositions } = await import('./engine.ts');
const { reconcile } = await import('./reconcile.ts');
const { usdc } = await import('../money.ts');
const { fee, notional } = await import('@pokex/pricing');

await initDb();
const db = await getDb();

// one card market priced at $1000
await ingest(db, async () => fromPokemontcg([
  { id: 'card-x', name: 'Test', number: '1', images: { small: 'x' }, tcgplayer: { prices: { holofoil: { market: 1000 } } } },
]));
const markets = await listMarketsWithData(db);
const market = markets.find((m) => m.symbol === 'card-x')!;

async function newUser(): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1, $2)`, [id, 'pk-' + id.slice(0, 8)]);
  await creditFaucet(db, id, 10_000);
  return id;
}
async function closeAll(userId: string): Promise<void> {
  for (const p of await getUserPositions(db, userId)) {
    await closePosition(db, userId, { positionId: p.id, fractionBps: 10_000, idempotencyKey: randomUUID() });
  }
}
const U = (n: number) => usdc(n).toString();

// The mark reflects market-wide skew, so each test closes its positions to reset OI to 0.

test('open a 10x long locks the right margin and computes the liq price', async () => {
  const userId = await newUser();
  await openPosition(db, userId, { marketId: market.id, side: 'long', qtyE6: 5_000_000n, leverage: 10, idempotencyKey: randomUUID() });

  const b = await getUserBalances(db, userId);
  // $5000 notional / 10x = $500 margin; open fee 0.1% of $5000 = $5
  assert.equal(b.availableUusdc.toString(), U(9_495));
  assert.equal(b.lockedMarginUusdc.toString(), U(500));

  const [pos] = await getUserPositions(db, userId);
  assert.equal(pos.avgEntryE6, (1000n * 1_000_000n).toString());
  assert.equal(pos.liqPriceE6, (925n * 1_000_000n).toString()); // 1000 * (1 - 0.1 + 0.025)

  await closeAll(userId);
});

test('closing a profitable long pays out from the LP pool and conserves value', async () => {
  const userId = await newUser();
  await openPosition(db, userId, { marketId: market.id, side: 'long', qtyE6: 5_000_000n, leverage: 10, idempotencyKey: randomUUID() });
  const [pos] = await getUserPositions(db, userId);
  assert.equal(pos.markE6, (1005n * 1_000_000n).toString()); // own long skew lifts the mark 0.5%

  const close = await closePosition(db, userId, { positionId: pos.id, fractionBps: 10_000, idempotencyKey: randomUUID() });
  assert.equal(close.realizedPnlUusdc, U(25)); // 5 units * ($1005 - $1000)

  const openFee = fee(notional(5_000_000n, 1_000_000_000n), 10);
  const closeFee = fee(notional(5_000_000n, 1_005_000_000n), 10);
  const expected = usdc(10_000) - openFee - closeFee + usdc(25); // principal - fees + profit
  const b = await getUserBalances(db, userId);
  assert.equal(b.availableUusdc.toString(), expected.toString());
  assert.equal(b.lockedMarginUusdc.toString(), U(0));
  assert.equal((await getUserPositions(db, userId)).length, 0);
});

test('increasing a position volume-weights the entry', async () => {
  const userId = await newUser();
  await openPosition(db, userId, { marketId: market.id, side: 'long', qtyE6: 5_000_000n, leverage: 10, idempotencyKey: randomUUID() });
  await openPosition(db, userId, { marketId: market.id, side: 'long', qtyE6: 5_000_000n, leverage: 10, idempotencyKey: randomUUID() });
  const [pos] = await getUserPositions(db, userId);
  assert.equal(pos.qtyE6, (10_000_000n).toString());
  assert.equal(pos.avgEntryE6, (1_002_500_000n).toString()); // (5*1000 + 5*1005) / 10 = 1002.5
  await closeAll(userId);
});

test('rejects over-cap leverage, OI-cap breach, and insufficient balance', async () => {
  const userId = await newUser();
  await assert.rejects(
    openPosition(db, userId, { marketId: market.id, side: 'long', qtyE6: 5_000_000n, leverage: 50, idempotencyKey: randomUUID() }),
    /leverage/,
  );
  // $60k notional @ 20x = $3k margin (affordable) but exceeds the $50k per-side OI cap
  await assert.rejects(
    openPosition(db, userId, { marketId: market.id, side: 'long', qtyE6: 60_000_000n, leverage: 20, idempotencyKey: randomUUID() }),
    /open interest/,
  );
  // $20k notional @ 1x = $20k margin > $10k balance
  await assert.rejects(
    openPosition(db, userId, { marketId: market.id, side: 'long', qtyE6: 20_000_000n, leverage: 1, idempotencyKey: randomUUID() }),
    /insufficient/,
  );
});

test('order idempotency key prevents double execution', async () => {
  const userId = await newUser();
  const key = randomUUID();
  const a = await openPosition(db, userId, { marketId: market.id, side: 'long', qtyE6: 5_000_000n, leverage: 10, idempotencyKey: key });
  const b = await openPosition(db, userId, { marketId: market.id, side: 'long', qtyE6: 5_000_000n, leverage: 10, idempotencyKey: key });
  assert.equal(b.duplicate, true);
  assert.equal(a.positionId, b.positionId);
  assert.equal((await getUserPositions(db, userId))[0].qtyE6, (5_000_000n).toString());
  await closeAll(userId);
});

test('concurrent same-key partial close replays instead of double-charging or crashing', async () => {
  const userId = await newUser();
  await openPosition(db, userId, { marketId: market.id, side: 'long', qtyE6: 10_000_000n, leverage: 10, idempotencyKey: randomUUID() });
  const [pos] = await getUserPositions(db, userId);
  const key = randomUUID();

  // two racing partial (50%) closes with the same key: one executes, the other must replay it
  const [a, b] = await Promise.all([
    closePosition(db, userId, { positionId: pos.id, fractionBps: 5_000, idempotencyKey: key }),
    closePosition(db, userId, { positionId: pos.id, fractionBps: 5_000, idempotencyKey: key }),
  ]);
  assert.equal(a.closedQtyE6, U(5)); // 50% of 10 units
  assert.equal(b.closedQtyE6, a.closedQtyE6); // replayed, not re-executed
  assert.equal(a.orderId, b.orderId);

  // the position was reduced exactly once (5 units left, still open), not twice
  const [after1] = await getUserPositions(db, userId);
  assert.equal(after1.qtyE6, U(5));
  await closeAll(userId);
});

test('the slippage guard rejects a fill past the limit; feeBps is exposed on the markets list', async () => {
  assert.equal(market.feeBps, 10); // FEE_BPS=10 (set above) surfaced so clients can preview the real fee
  const userId = await newUser();
  // mark is $1000; a long with a $999 ceiling must reject before any side effects
  await assert.rejects(
    () => openPosition(db, userId, { marketId: market.id, side: 'long', qtyE6: 5_000_000n, leverage: 10, limitPriceE6: 999_000_000n, idempotencyKey: randomUUID() }),
    /limit/,
  );
  assert.equal((await getUserPositions(db, userId)).length, 0); // nothing opened
  // a $1000 ceiling fills at the $1000 mark
  await openPosition(db, userId, { marketId: market.id, side: 'long', qtyE6: 5_000_000n, leverage: 10, limitPriceE6: 1_000_000_000n, idempotencyKey: randomUUID() });
  const [pos] = await getUserPositions(db, userId);
  assert.equal(pos.avgEntryE6, U(1000));
  await closeAll(userId);
});

test('freshness gate: a reactivated market cannot be OPENED against a mark predating its activation', async () => {
  const userId = await newUser();
  // Simulate a reactivation: bump created_at past the market's existing (now "stale") mark.
  await db.query(`UPDATE markets SET created_at = now() WHERE id = $1`, [market.id]);
  await assert.rejects(
    openPosition(db, userId, { marketId: market.id, side: 'long', qtyE6: 5_000_000n, leverage: 10, idempotencyKey: randomUUID() }),
    /repricing/,
    'opening on a pre-activation mark is refused',
  );

  // A fresh print (mark computed_at >= created_at) reopens the market for new positions. The pokemontcg
  // path stamps a wall-clock observedAt, so re-ingesting lands a new source_observed_at -> a fresh print
  // + mark even at the same price (dedup keys on the timestamp, not the value).
  await ingest(db, async () => fromPokemontcg([
    { id: 'card-x', name: 'Test', number: '1', images: { small: 'x' }, tcgplayer: { prices: { holofoil: { market: 1000 } } } },
  ]));
  await openPosition(db, userId, { marketId: market.id, side: 'long', qtyE6: 5_000_000n, leverage: 10, idempotencyKey: randomUUID() });
  await closeAll(userId);
});

test('reconciler stays balanced after all trading activity', async () => {
  const report = await reconcile(db);
  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
});

after(async () => {
  await closeDb();
});
