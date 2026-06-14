import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
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
const { userLevel, userStanding } = await import('./leaderboard.ts');
const { getProfileCard } = await import('./chat.ts');
const { usdc } = await import('../money.ts');

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
async function winTrade(user: string, profit: number): Promise<void> {
  await setMark(1000);
  await openPosition(db, user, { marketId: market.id, side: 'long', qtyE6: 1_000_000n, leverage: 5, idempotencyKey: randomUUID() });
  await setMark(1000 + profit);
  const [pos] = await getUserPositions(db, user);
  await closePosition(db, user, { positionId: pos.id, fractionBps: 10_000, idempotencyKey: randomUUID() });
  await setMark(1000);
}

// ALL users created before the first userStanding() call, so the cached snapshot includes everyone.
const a = await newUser(); await winTrade(a, 300); // +$300, ~$2.3k volume
const b = await newUser(); await winTrade(b, 200); // +$200
const c = await newUser(); await winTrade(c, 100); // +$100
const idle = await newUser(); // faucet only — no trades

test('userLevel maps cumulative volume to tiers L1..L6', () => {
  assert.equal(userLevel(0n), 1);
  assert.equal(userLevel(usdc(999)), 1);
  assert.equal(userLevel(usdc(1000)), 2);
  assert.equal(userLevel(usdc(9999)), 2);
  assert.equal(userLevel(usdc(10_000)), 3);
  assert.equal(userLevel(usdc(50_000)), 4);
  assert.equal(userLevel(usdc(250_000)), 5);
  assert.equal(userLevel(usdc(1_000_000)), 6);
});

test('userStanding + getProfileCard expose rank, level and identity', async () => {
  const sa = await userStanding(db, a);
  assert.equal(sa.rank, 1, 'biggest winner is #1');
  assert.equal(sa.level, 2, '~$2.3k volume -> L2');

  const sIdle = await userStanding(db, idle);
  assert.equal(sIdle.rank, 4, 'no-PnL user ranks last');
  assert.equal(sIdle.level, 1, 'no volume -> L1');

  const card = await getProfileCard(db, a);
  assert.equal(card.rank, 1);
  assert.equal(card.level, 2);
  assert.equal(card.isMod, false);
  assert.ok(card.handle, 'handle present');
  assert.equal(card.total, 4);

  await assert.rejects(getProfileCard(db, randomUUID()), /user not found/);
});

after(async () => {
  await closeDb();
});
