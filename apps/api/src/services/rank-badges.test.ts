import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
// hermetic: zero fee so realized PnL == profit, and keep action bars out of the way (vs a local .env)
process.env.FEE_BPS = '0';
process.env.CHAT_BIG_BET_USD = '100000';
process.env.CHAT_BIG_WIN_USD = '100000';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { ingest } = await import('./oracle.ts');
const { fromPokemontcg } = await import('./providers/pokemontcg.ts');
const { listMarketsWithData } = await import('./markets.ts');
const { creditFaucet } = await import('./faucet.ts');
const { openPosition, closePosition, getUserPositions } = await import('./engine.ts');
const { rankMap, getLeaderboard } = await import('./leaderboard.ts');

await initDb();
const db = await getDb();
await ingest(db, async () => fromPokemontcg([
  { id: 'card-x', name: 'Test', number: '1', images: { small: '' }, tcgplayer: { prices: { holofoil: { market: 1000 } } } },
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
// open 1 unit @ $1000 then close $`profit` higher -> realized PnL = profit (fee 0)
async function winTrade(user: string, profit: number): Promise<void> {
  await setMark(1000);
  await openPosition(db, user, { marketId: market.id, side: 'long', qtyE6: 1_000_000n, leverage: 5, idempotencyKey: randomUUID() });
  await setMark(1000 + profit);
  const [pos] = await getUserPositions(db, user);
  await closePosition(db, user, { positionId: pos.id, fractionBps: 10_000, idempotencyKey: randomUUID() });
  await setMark(1000);
}

test('rankMap ranks traders by realized PnL (1-based) and agrees with the leaderboard', async () => {
  const a = await newUser(); await winTrade(a, 300); // +$300
  const b = await newUser(); await winTrade(b, 200); // +$200
  const c = await newUser(); await winTrade(c, 100); // +$100

  const { ranks, total } = await rankMap(db);
  assert.equal(total, 3);
  assert.equal(ranks[a], 1, 'biggest winner is #1');
  assert.equal(ranks[b], 2);
  assert.equal(ranks[c], 3);

  const lb = await getLeaderboard(db, { limit: 10 });
  assert.deepEqual(lb.rows.map((r) => r.userId), [a, b, c], 'rankMap order matches getLeaderboard');
});

after(async () => {
  await closeDb();
});
