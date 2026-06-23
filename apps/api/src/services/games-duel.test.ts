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
const { joinOrCreateDuel, getDuel, cancelDuel, settleExpiredDuels } = await import('./games-duel.ts');
const { seedGamePool } = await import('./games.ts');
const { setPriceDuelConfig } = await import('./game-config.ts');

const db = await getDb();
await migrate();

const cfg = (anteUsd = 25, windowHours = 1, rakeBps = 500) => setPriceDuelConfig(db, { enabled: true, anteUsd, windowHours, rakeBps, bigWinUsd: 1_000_000 });

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
const setMark = (marketId: string, usdVal: number) => db.query(`INSERT INTO marks(market_id, mark_price_e6, index_price_e6) VALUES($1,$2,$2)`, [marketId, usdc(usdVal).toString()]);
const forceClose = (duelId: string) => db.query(`UPDATE game_rounds SET params = jsonb_set(params, '{closeAt}', to_jsonb((now() - interval '1 hour')::text)) WHERE id = $1`, [duelId]);

const CARD_A = await featuredCard('CARD-A', 100);
const CARD_B = await featuredCard('CARD-B', 100);
await seedGamePool(db, 1_000_000);

test('a duel quick-matches: creator opens, opponent locks both picks and starts the window', async () => {
  await cfg();
  const p1 = await newUser();
  const p2 = await newUser();
  const v1 = await joinOrCreateDuel(db, p1, CARD_A, randomUUID());
  assert.equal(v1.status, 'open');
  assert.equal(v1.role, 'creator');
  assert.equal(v1.yourCard?.marketId, CARD_A);
  assert.equal(v1.oppCard, null, 'no opponent yet');
  assert.equal((await getUserBalances(db, p1)).availableUusdc, usdc(10_000) - usdc(25), 'creator antes');
  const v2 = await joinOrCreateDuel(db, p2, CARD_B, randomUUID());
  assert.equal(v2.status, 'active');
  assert.equal(v2.role, 'opponent');
  assert.equal(v2.oppCard?.marketId, CARD_A, 'the creator pick is revealed once matched');
  assert.ok(v2.closeAt);
  assert.equal((await getUserBalances(db, p2)).availableUusdc, usdc(10_000) - usdc(25), 'opponent antes');
  assert.ok((await reconcile(db)).ok);
});

test('an open duel hides the creator pick from a non-participant (anti-copy)', async () => {
  await cfg();
  const p1 = await newUser();
  const p3 = await newUser();
  const v = await joinOrCreateDuel(db, p1, CARD_A, randomUUID());
  const peek = (await getDuel(db, p3, v.duelId))!;
  assert.equal(peek.role, null);
  assert.equal(peek.yourCard, null);
  assert.equal(peek.oppCard, null, 'the creator pick is hidden while the duel is open');
  await cancelDuel(db, p1, v.duelId); // tidy up the open duel
});

test('an active duel hides both picks from a non-participant until it settles', async () => {
  await cfg();
  const p1 = await newUser();
  const p2 = await newUser();
  const p3 = await newUser();
  await joinOrCreateDuel(db, p1, CARD_A, randomUUID());
  const v2 = await joinOrCreateDuel(db, p2, CARD_B, randomUUID()); // matched → active
  const part = (await getDuel(db, p1, v2.duelId))!;
  assert.ok(part.yourCard && part.oppCard, 'participants see both picks while active');
  const peek = (await getDuel(db, p3, v2.duelId))!;
  assert.equal(peek.yourCard, null);
  assert.equal(peek.oppCard, null, 'a stranger cannot see active-duel picks (no mid-duel signal)');
  await forceClose(v2.duelId);
  await settleExpiredDuels(db);
  assert.ok((await getDuel(db, p3, v2.duelId))!.oppCard, 'picks become public once the duel settles');
});

test('the higher %-move wins the pot minus rake', async () => {
  await cfg(25, 1, 500);
  const p1 = await newUser();
  const p2 = await newUser();
  await joinOrCreateDuel(db, p1, CARD_A, randomUUID());
  const v2 = await joinOrCreateDuel(db, p2, CARD_B, randomUUID()); // both started at $100
  await setMark(CARD_A, 150); // +50%
  await setMark(CARD_B, 110); // +10% → creator wins
  await forceClose(v2.duelId);
  assert.equal(await settleExpiredDuels(db), 1, 'the worker settles the expired duel');
  const s = (await getDuel(db, p1, v2.duelId))!;
  assert.equal(s.status, 'settled');
  assert.equal(s.result?.winner, 'creator');
  assert.equal(s.result?.youWon, true);
  assert.equal(s.result?.payoutE6, usdc(47.5).toString(), 'pot $50 minus 5% rake');
  assert.equal((await getUserBalances(db, p1)).availableUusdc, usdc(10_000) - usdc(25) + usdc(47.5));
  assert.equal((await getUserBalances(db, p2)).availableUusdc, usdc(10_000) - usdc(25));
  assert.ok((await reconcile(db)).ok);
});

test('a tie (equal %-move) refunds both, no rake', async () => {
  await cfg();
  const p1 = await newUser();
  const p2 = await newUser();
  await joinOrCreateDuel(db, p1, CARD_A, randomUUID());
  const v2 = await joinOrCreateDuel(db, p2, CARD_B, randomUUID());
  await forceClose(v2.duelId); // no mark change → both 0% → tie
  await settleExpiredDuels(db);
  const s = (await getDuel(db, p1, v2.duelId))!;
  assert.equal(s.result?.winner, 'tie');
  assert.equal((await getUserBalances(db, p1)).availableUusdc, usdc(10_000), 'p1 refunded in full');
  assert.equal((await getUserBalances(db, p2)).availableUusdc, usdc(10_000), 'p2 refunded in full');
  assert.ok((await reconcile(db)).ok);
});

test('joining is idempotent — the same key does not ante twice', async () => {
  await cfg();
  const p1 = await newUser();
  const key = randomUUID();
  const a = await joinOrCreateDuel(db, p1, CARD_A, key);
  const b = await joinOrCreateDuel(db, p1, CARD_A, key);
  assert.equal(b.duelId, a.duelId);
  assert.equal((await getUserBalances(db, p1)).availableUusdc, usdc(10_000) - usdc(25), 'charged exactly one ante');
  await cancelDuel(db, p1, a.duelId);
});

test('a cross-game idempotency-key collision returns a clean 409, not a crash', async () => {
  await cfg();
  const u = await newUser();
  const key = randomUUID();
  // The (user, key) index is global — simulate the key already used by another game.
  await db.query(`INSERT INTO game_plays(id, game_type, user_id, idempotency_key, wager_uusdc) VALUES($1, 'pack-rip', $2, $3, 0)`, [randomUUID(), u, key]);
  await assert.rejects(joinOrCreateDuel(db, u, CARD_A, key), /already used/, 'the foreign key is rejected, not dereferenced to null');
});

test('only the creator can cancel, and only while unmatched', async () => {
  await cfg();
  const p1 = await newUser();
  const p2 = await newUser();
  const v = await joinOrCreateDuel(db, p1, CARD_A, randomUUID());
  await assert.rejects(cancelDuel(db, p2, v.duelId), /creator/, 'a stranger cannot cancel');
  await cancelDuel(db, p1, v.duelId);
  assert.equal((await getUserBalances(db, p1)).availableUusdc, usdc(10_000), 'creator refunded on cancel');
  assert.equal((await getDuel(db, p1, v.duelId))!.status, 'cancelled');
  await assert.rejects(cancelDuel(db, p1, v.duelId), /unmatched/, 'a cancelled duel cannot be cancelled again');
  assert.ok((await reconcile(db)).ok);
});
