import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
// Pin thresholds + fee so the test is hermetic — a local apps/api/.env (loaded by dotenv) must not
// change the numbers this test asserts. BIG BET >= $500 notional, BIG WIN > $100 realized profit, fee 0.
process.env.CHAT_BIG_BET_USD = '500';
process.env.CHAT_BIG_WIN_USD = '100';
process.env.FEE_BPS = '0';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { ingest } = await import('./oracle.ts');
const { fromPokemontcg } = await import('./providers/pokemontcg.ts');
const { listMarketsWithData } = await import('./markets.ts');
const { creditFaucet } = await import('./faucet.ts');
const { openPosition, closePosition, getUserPositions } = await import('./engine.ts');

await initDb();
const db = await getDb();
await ingest(db, async () => fromPokemontcg([
  { id: 'card-x', name: 'Test Card', number: '1', images: { small: 'x' }, tcgplayer: { prices: { holofoil: { market: 1000 } } } },
]));
const market = (await listMarketsWithData(db)).find((m) => m.symbol === 'card-x')!;

async function newUser(): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1, $2)`, [id, 'pk-' + id.slice(0, 8)]);
  await creditFaucet(db, id, 100_000);
  return id;
}
async function setMark(price: number): Promise<void> {
  const e6 = (BigInt(Math.round(price * 1000)) * 1000n).toString();
  await db.query(`INSERT INTO marks(market_id, mark_price_e6, index_price_e6) VALUES($1, $2, $2)`, [market.id, e6]);
}
async function events(): Promise<{ variant: string; side: string; notional: string; pnl: string | null; roe: string | null }[]> {
  const r = await db.query<{ variant: string; side: string; notional: string; pnl: string | null; roe: string | null }>(
    `SELECT meta->>'variant' AS variant, meta->>'side' AS side, meta->>'notionalE6' AS notional,
            meta->>'pnlE6' AS pnl, meta->>'roeBps' AS roe
     FROM chat_messages WHERE kind='event' ORDER BY created_at, id`,
  );
  return r.rows;
}

test('a large open broadcasts a BIG BET action bar; close at profit broadcasts a BIG WIN with ROE', async () => {
  const trader = await newUser();
  // 1 unit @ $1000 = $1000 notional (>= $500) @ 20x => $50 margin
  await openPosition(db, trader, { marketId: market.id, side: 'long', qtyE6: 1_000_000n, leverage: 20, idempotencyKey: randomUUID() });

  let evs = await events();
  assert.equal(evs.length, 1, 'one event after the big open');
  assert.equal(evs[0].variant, 'big_bet');
  assert.equal(evs[0].side, 'long');
  assert.equal(evs[0].notional, '1000000000'); // $1000 in e6

  // move the mark up and close the whole position: pnl = 1*($1200-$1000) = $200 (>= $100)
  await setMark(1200);
  const positions = await getUserPositions(db, trader);
  const closeKey = randomUUID();
  await closePosition(db, trader, { positionId: positions[0].id, fractionBps: 10_000, idempotencyKey: closeKey });

  evs = await events();
  assert.equal(evs.length, 2, 'a second event after the profitable close');
  assert.equal(evs[1].variant, 'big_win');
  assert.equal(evs[1].pnl, '200000000'); // $200 profit in e6
  assert.equal(evs[1].roe, '40000'); // ROE = $200 / $50 margin = 400% = 40000 bps

  // replaying the same close (idempotent) must NOT re-announce
  await closePosition(db, trader, { positionId: positions[0].id, fractionBps: 10_000, idempotencyKey: closeKey });
  assert.equal((await events()).length, 2, 'idempotent replay does not duplicate the event');
});

test('a small open does not broadcast a BIG BET', async () => {
  const trader = await newUser();
  await setMark(1000);
  // 0.4 units @ $1000 = $400 notional (< $500 threshold)
  await openPosition(db, trader, { marketId: market.id, side: 'short', qtyE6: 400_000n, leverage: 20, idempotencyKey: randomUUID() });
  assert.equal((await events()).length, 2, 'no new event for a sub-threshold open');
});

after(async () => {
  await closeDb();
});
