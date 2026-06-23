import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.GAMES_ENABLED = 'true';

const { getDb } = await import('../db/client.ts');
const { migrate } = await import('../db/migrate.ts');
const { creditFaucet, getUserBalances } = await import('./faucet.ts');
const { reconcile } = await import('./reconcile.ts');
const { usdc } = await import('../money.ts');
const { joinArena, getArena, settleExpiredArenas } = await import('./games-arena.ts');
const { seedGamePool } = await import('./games.ts');
const { setDraftArenaConfig } = await import('./game-config.ts');

const db = await getDb();
await migrate();

const cfg = (spots = 2, rosterSize = 2, poolSize = 4, entryUsd = 25, rakeBps = 1000) =>
  setDraftArenaConfig(db, { enabled: true, entryUsd, spots, rosterSize, poolSize, rakeBps, windowHours: 168, lobbyTimeoutHours: 24, bigWinUsd: 1_000_000 });

async function newUser(faucetUsd = 10_000): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1, $2)`, [id, 'pk-' + id.slice(0, 8)]);
  await creditFaucet(db, id, faucetUsd);
  return id;
}
async function featuredCard(symbol: string, markUsd: number): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO markets(id, kind, game, symbol, display_name, status, tradeable, featured) VALUES($1,'card','pokemon',$2,$3,'active',true,true)`, [id, symbol, symbol]);
  await db.query(`INSERT INTO marks(market_id, mark_price_e6, index_price_e6) VALUES($1,$2,$2)`, [id, usdc(markUsd).toString()]);
  return id;
}
const markPast = (id: string, usd: number, interval: string) =>
  db.query(`INSERT INTO marks(market_id, mark_price_e6, index_price_e6, computed_at) VALUES($1,$2,$2, now() - interval '${interval}')`, [id, usdc(usd).toString()]);
const forceClose = (id: string) =>
  db.query(`UPDATE game_rounds SET params = jsonb_set(params, '{closeAt}', to_jsonb((now() - interval '1 minute')::text)) WHERE id = $1`, [id]);
const forceLobbyTimeout = (id: string) =>
  db.query(`UPDATE game_rounds SET params = jsonb_set(params, '{lobbyDeadline}', to_jsonb((now() - interval '1 minute')::text)) WHERE id = $1`, [id]);
const clear = async (id: string) => { await forceLobbyTimeout(id); await settleExpiredArenas(db); };

// pool (top 4 by value) = C5,C4,C3,C2; C1 is below the pool cap.
const C5 = await featuredCard('C5', 500);
const C4 = await featuredCard('C4', 400);
const C3 = await featuredCard('C3', 300);
const C2 = await featuredCard('C2', 200);
const C1 = await featuredCard('C1', 100);
await seedGamePool(db, 1_000_000);
const POOL = [C5, C4, C3, C2];

test('a full lobby fair-shuffles seats and snake-drafts disjoint rosters', async () => {
  await cfg(2, 2, 4);
  const u1 = await newUser();
  const u2 = await newUser();
  await joinArena(db, u1, POOL, randomUUID());
  const v = await joinArena(db, u2, POOL, randomUUID()); // 2nd join fills → drafts
  assert.equal(v.status, 'battle');
  const a1 = (await getArena(db, u1, v.roundId))!.yourEntry!.roster.map((c) => c.marketId);
  const a2 = (await getArena(db, u2, v.roundId))!.yourEntry!.roster.map((c) => c.marketId);
  assert.equal(a1.length, 2);
  assert.equal(a2.length, 2);
  assert.equal(new Set([...a1, ...a2]).size, 4, 'rosters are disjoint and cover the drafted pool');
  assert.equal((await getUserBalances(db, u1)).availableUusdc, usdc(10_000) - usdc(25));
  assert.ok((await reconcile(db)).ok);
});

test('the top roster %-move takes the pot minus rake', async () => {
  await cfg(2, 2, 4, 25, 1000);
  const u1 = await newUser();
  const u2 = await newUser();
  await joinArena(db, u1, POOL, randomUUID());
  const v = await joinArena(db, u2, POOL, randomUUID());
  // bump u1's drafted cards +50% (backdated before the close), leave u2's flat → u1 wins
  const a1 = (await getArena(db, u1, v.roundId))!.yourEntry!.roster;
  for (const c of a1) await markPast(c.marketId, (Number(c.valueE6) / 1e6) * 1.5, '30 minutes');
  await forceClose(v.roundId);
  await settleExpiredArenas(db);
  const res = (await getArena(db, u1, v.roundId))!;
  assert.equal(res.status, 'settled');
  assert.equal(res.yourEntry!.prizeE6, usdc(45).toString(), 'pot $50 minus 10% rake');
  assert.equal((await getUserBalances(db, u1)).availableUusdc, usdc(10_000) - usdc(25) + usdc(45));
  assert.equal((await getUserBalances(db, u2)).availableUusdc, usdc(10_000) - usdc(25));
  assert.ok((await reconcile(db)).ok);
  assert.ok(res.fairness.serverSeed, 'the server seed is revealed once settled');
});

test('an unfilled lobby refunds everyone after the fill timeout', async () => {
  await cfg(2, 2, 4);
  const u1 = await newUser();
  const v = await joinArena(db, u1, POOL, randomUUID()); // 1/2 → still open
  assert.equal(v.status, 'open');
  await forceLobbyTimeout(v.roundId);
  await settleExpiredArenas(db);
  assert.equal((await getArena(db, u1, v.roundId))!.status, 'cancelled');
  assert.equal((await getUserBalances(db, u1)).availableUusdc, usdc(10_000), 'refunded in full');
  assert.ok((await reconcile(db)).ok);
});

test('joining is idempotent — the same key does not charge twice', async () => {
  await cfg(2, 2, 4);
  const u1 = await newUser();
  const key = randomUUID();
  const a = await joinArena(db, u1, POOL, key);
  const b = await joinArena(db, u1, POOL, key);
  assert.equal(b.roundId, a.roundId);
  assert.equal((await getUserBalances(db, u1)).availableUusdc, usdc(10_000) - usdc(25), 'charged once');
  await clear(a.roundId);
});

test('a wishlist must be distinct, long enough, and drawn from the pool', async () => {
  await cfg(2, 2, 4);
  const u1 = await newUser();
  await assert.rejects(joinArena(db, u1, [C5, C5], randomUUID()), /distinct/);
  await assert.rejects(joinArena(db, u1, [C5], randomUUID()), /at least 2/);
  await assert.rejects(joinArena(db, u1, [C5, C1], randomUUID()), /pool/, 'C1 is below the pool cap');
  assert.equal((await getUserBalances(db, u1)).availableUusdc, usdc(10_000), 'nothing charged on a bad wishlist');
});

test('a user can only join a lobby once', async () => {
  await cfg(2, 2, 4);
  const u1 = await newUser();
  const v = await joinArena(db, u1, POOL, randomUUID());
  await assert.rejects(joinArena(db, u1, POOL, randomUUID()), /already joined/);
  await clear(v.roundId);
});
