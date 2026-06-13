import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { upsertCardMarket } = await import('./markets.ts');
const { marketStats } = await import('./admin-stats.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

const e6 = (n: number) => (BigInt(n) * 1_000_000n).toString();

async function user(): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1, $2)`, [id, 'pk-' + id.slice(0, 8)]);
  return id;
}
async function position(marketId: string, side: 'long' | 'short', qty: number, entry: number, margin: number) {
  await db.query(
    `INSERT INTO positions(id, user_id, market_id, side, qty_e6, avg_entry_e6, margin_uusdc, leverage_e2, status)
     VALUES($1, $2, $3, $4, $5, $6, $7, 100, 'open')`,
    [randomUUID(), await user(), marketId, side, e6(qty), e6(entry), e6(margin)],
  );
}

test('marketStats: capped vs raw net P/L (the isolated-margin example) + locked + L/S notional', async () => {
  const marketId = await upsertCardMarket(db, {
    game: 'pokemon', symbol: 'stat-1', cardId: 'stat-1', displayName: 'Stat Card', variant: null, imageSmall: null,
  });
  await db.query(`INSERT INTO marks(market_id, mark_price_e6, index_price_e6) VALUES($1, $2, $2)`, [marketId, e6(1000)]);

  // Player A long: entry 900, qty 1 -> uPnL = (1000-900)*1 = +$100, margin $1000 (never capped)
  await position(marketId, 'long', 1, 900, 1000);
  // Player B short: entry 940, qty 5 -> uPnL = (940-1000)*5 = -$300, but only $50 margin (loss capped at 50)
  await position(marketId, 'short', 5, 940, 50);

  const r = await marketStats(db);
  const s = r.markets.find((m) => m.marketId === marketId)!;

  assert.equal(s.netRawE6, e6(-200), 'raw = +100 - 300 = -200 (paper)');
  assert.equal(s.netCappedE6, e6(50), 'capped = +100 - 50 (B can only lose its margin) = +50');
  assert.equal(s.lockedE6, e6(1050), 'locked margin = 1000 + 50');
  assert.equal(s.longNotionalE6, e6(900), 'long notional = qty 1 × entry 900');
  assert.equal(s.shortNotionalE6, e6(4700), 'short notional = qty 5 × entry 940');
  assert.equal(s.volume24hE6, '0', 'no fills yet');

  // totals roll up the same way across the (single) market
  assert.equal(r.totals.netCappedE6, e6(50));
  assert.equal(r.totals.netRawE6, e6(-200));
});

test('marketStats: 24h volume comes from fills within the window', async () => {
  const marketId = await upsertCardMarket(db, {
    game: 'pokemon', symbol: 'stat-2', cardId: 'stat-2', displayName: 'Vol Card', variant: null, imageSmall: null,
  });
  const uid = await user();
  const oid = randomUUID();
  await db.query(
    `INSERT INTO orders(id, user_id, market_id, kind, side, qty_e6, leverage_e2, status, idempotency_key)
     VALUES($1,$2,$3,'market','long',2000000,100,'filled',$4)`,
    [oid, uid, marketId, randomUUID()],
  );
  const pid = randomUUID();
  await db.query(
    `INSERT INTO positions(id, user_id, market_id, side, qty_e6, avg_entry_e6, margin_uusdc, leverage_e2, status)
     VALUES($1,$2,$3,'long',2000000,$4,10000000,100,'open')`,
    [pid, uid, marketId, e6(100)],
  );
  // a $200 fill now (in-window) and a $1000 fill 2 days ago (out of window)
  await db.query(
    `INSERT INTO fills(id, order_id, position_id, market_id, exec_price_e6, qty_e6, created_at)
     VALUES($1,$2,$3,$4,100000000,2000000, now()),
            ($5,$2,$3,$4,100000000,10000000, now() - interval '2 days')`,
    [randomUUID(), oid, pid, marketId, randomUUID()],
  );
  const s = (await marketStats(db)).markets.find((m) => m.marketId === marketId)!;
  assert.equal(s.volume24hE6, e6(200), 'only the in-window fill counts (2.0 × $100)');
});
