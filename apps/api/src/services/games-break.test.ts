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
const { joinBreak, currentBreak, getBreakRound, breakEv, cancelBreak } = await import('./games-break.ts');
const { sellBackPrize, seedGamePool } = await import('./games.ts');
const { setTheBreakConfig } = await import('./game-config.ts');
const { fairShuffle, verify } = await import('./game-fairness.ts');

const db = await getDb();
await migrate();

const SPREAD = 1200;
const WIDE = [{ minUsd: 0, maxUsd: 1000, weight: 1 }];
const cfg = (spots: number) => setTheBreakConfig(db, { enabled: true, spots, entryUsd: 25, buybackSpreadBps: SPREAD, maxPrizeUsd: 5_000_000, bigWinUsd: 1_000_000, bands: WIDE });

async function newUser(faucetUsd = 10_000): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1, $2)`, [id, 'pk-' + id.slice(0, 8)]);
  await creditFaucet(db, id, faucetUsd);
  return id;
}
async function featuredCard(symbol: string, markUsd: number): Promise<void> {
  const id = randomUUID();
  await db.query(`INSERT INTO markets(id, kind, game, symbol, display_name, status, tradeable, featured) VALUES($1,'card','pokemon',$2,$3,'active',true,true)`, [id, symbol, symbol]);
  await db.query(`INSERT INTO marks(market_id, mark_price_e6, index_price_e6) VALUES($1,$2,$2)`, [id, usdc(markUsd).toString()]);
}

await featuredCard('CARD-A', 10);
await featuredCard('CARD-B', 50);
await featuredCard('CARD-C', 400);
await seedGamePool(db, 5_000_000);

// Fill a fresh case with `n` users (each a new spot); returns the users + the filling join's view.
async function fillCase(n: number): Promise<{ users: string[]; view: Awaited<ReturnType<typeof joinBreak>> }> {
  const users: string[] = [];
  let view!: Awaited<ReturnType<typeof joinBreak>>;
  for (let i = 0; i < n; i++) {
    const u = await newUser();
    users.push(u);
    view = await joinBreak(db, u, randomUUID());
  }
  return { users, view };
}

test('breakEv reports a per-spot house edge vs the live pool', async () => {
  await cfg(3);
  const ev = await breakEv(db);
  assert.equal(ev.spots, 3);
  assert.equal(ev.entryUsd, 25);
  assert.ok(ev.eligibleBands >= 1 && ev.poolSize >= 3);
  assert.equal(typeof ev.houseEdgeBps, 'number');
});

test('a case fills, every entrant wins one spot card, and the ledger balances', async () => {
  await cfg(3);
  const { users, view } = await fillCase(3);
  assert.equal(view.status, 'settled', 'the third entry fills + resolves the case');
  const won: string[] = [];
  for (const u of users) {
    const v = (await getBreakRound(db, u, view.roundId))!;
    assert.equal(v.yourSpots.length, 1, 'one spot each');
    assert.ok(v.yourSpots[0].card && v.yourSpots[0].prizeId, 'a card + a sellable prize');
    won.push(v.yourSpots[0].card!.marketId);
  }
  // The won cards are exactly the case's cards (the shuffle is a permutation of the N card slots).
  assert.deepEqual(won.map(String).sort(), view.cards.map((c) => c.marketId).sort());
  assert.ok((await reconcile(db)).ok, 'ledger reconciles after a full break');
});

test('the spot assignment + seed are independently verifiable from the revealed seed', async () => {
  await cfg(3);
  const { view } = await fillCase(3);
  assert.ok(view.revealedServerSeed && view.assignment, 'a settled case reveals the seed + assignment');
  assert.ok(verify(view.revealedServerSeed!, view.serverSeedHash), 'the revealed seed matches the commitment');
  const shuffle = fairShuffle(view.revealedServerSeed!, view.clientSeed, 0, view.spots, 2 * view.spots);
  for (let spot = 0; spot < view.spots; spot++) {
    assert.equal(view.assignment![spot].card.marketId, view.cards[shuffle[spot]].marketId, `spot ${spot} recomputes from the shuffle`);
  }
});

test('a won break card sells back for USDC at mark x (1 - spread)', async () => {
  await cfg(2);
  const { users, view } = await fillCase(2);
  const v = (await getBreakRound(db, users[0], view.roundId))!;
  const spot = v.yourSpots[0];
  const before = (await getUserBalances(db, users[0])).availableUusdc;
  const sell = await sellBackPrize(db, users[0], spot.prizeId!);
  const expected = (BigInt(spot.card!.valueE6) * BigInt(10_000 - SPREAD)) / 10_000n;
  assert.equal(sell.payoutE6, expected.toString());
  assert.equal((await getUserBalances(db, users[0])).availableUusdc, before + expected);
  assert.ok((await reconcile(db)).ok, 'ledger reconciles after the break-prize sell-back');
});

test('joining is idempotent — the same key does not buy a second spot', async () => {
  await cfg(2);
  const u1 = await newUser();
  const key = randomUUID();
  await joinBreak(db, u1, key);
  await joinBreak(db, u1, key); // replay: no fill, no second charge
  assert.equal((await getUserBalances(db, u1)).availableUusdc, usdc(10_000) - usdc(25), 'charged one entry');
  const u2 = await newUser();
  const v = await joinBreak(db, u2, randomUUID()); // fills it
  assert.equal(v.status, 'settled');
  assert.equal((await getBreakRound(db, u1, v.roundId))!.yourSpots.length, 1, 'u1 holds exactly one spot');
});

test('replaying a join after the case settled does not spawn an orphan open case', async () => {
  await cfg(2);
  const u1 = await newUser();
  const key = randomUUID();
  await joinBreak(db, u1, key); // spot 0 (1/2, open)
  const u2 = await newUser();
  await joinBreak(db, u2, randomUUID()); // fills → settled; no open case now
  const replay = await joinBreak(db, u1, key); // replay with no open case present
  assert.equal(replay.status, 'settled', 'the replay returns the original (now settled) case');
  assert.equal(await currentBreak(db, u1), null, 'no orphaned no-wager case was created by the replay');
});

test('a mid-case entry-price change does not alter the case price or its refund', async () => {
  await cfg(5); // entry $25
  const u1 = await newUser();
  const v = await joinBreak(db, u1, randomUUID());
  assert.equal((await getUserBalances(db, u1)).availableUusdc, usdc(10_000) - usdc(25));
  await setTheBreakConfig(db, { entryUsd: 100 }); // admin raises the price mid-case
  const u2 = await newUser();
  await joinBreak(db, u2, randomUUID());
  assert.equal((await getUserBalances(db, u2)).availableUusdc, usdc(10_000) - usdc(25), 'a late joiner pays the CASE price, not the new knob');
  const res = await cancelBreak(db, v.roundId);
  assert.equal(res.refunded, 2);
  assert.equal((await getUserBalances(db, u1)).availableUusdc, usdc(10_000), 'u1 refunded exactly $25');
  assert.equal((await getUserBalances(db, u2)).availableUusdc, usdc(10_000), 'u2 refunded exactly $25');
});

test('cancelling an open case refunds every entrant', async () => {
  await cfg(5);
  const u1 = await newUser();
  const u2 = await newUser();
  const v = await joinBreak(db, u1, randomUUID());
  await joinBreak(db, u2, randomUUID()); // 2 of 5 — still open
  const res = await cancelBreak(db, v.roundId);
  assert.equal(res.refunded, 2);
  assert.equal((await getUserBalances(db, u1)).availableUusdc, usdc(10_000), 'u1 refunded');
  assert.equal((await getUserBalances(db, u2)).availableUusdc, usdc(10_000), 'u2 refunded');
  assert.equal((await getBreakRound(db, u1, v.roundId))!.status, 'cancelled');
  assert.ok((await reconcile(db)).ok, 'ledger reconciles after a cancel + refund');
});
