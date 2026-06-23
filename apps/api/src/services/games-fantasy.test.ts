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
const { enterFantasy, getLeague, settleExpiredLeagues } = await import('./games-fantasy.ts');
const { seedGamePool } = await import('./games.ts');
const { setCardFantasyConfig } = await import('./game-config.ts');

const db = await getDb();
await migrate();

const cfg = (rosterSize = 2, capUsd = 300, entryUsd = 25, rakeBps = 1000, minEntries = 2) =>
  setCardFantasyConfig(db, { enabled: true, entryUsd, capUsd, rosterSize, windowHours: 168, rakeBps, minEntries, bigWinUsd: 1_000_000 });

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
// A backdated mark (computed_at in the past) so it counts toward a forced-closed league's close marks.
const markPast = (id: string, usd: number, interval: string) =>
  db.query(`INSERT INTO marks(market_id, mark_price_e6, index_price_e6, computed_at) VALUES($1,$2,$2, now() - interval '${interval}')`, [id, usdc(usd).toString()]);
// Force the league's window closed (1 min ago); optionally run the settle sweep.
const forceClose = (leagueId: string) =>
  db.query(`UPDATE game_rounds SET params = jsonb_set(params, '{closeAt}', to_jsonb((now() - interval '1 minute')::text)) WHERE id = $1`, [leagueId]);
async function settleLeagueNow(leagueId: string) {
  await forceClose(leagueId);
  await settleExpiredLeagues(db);
}

const A = await featuredCard('CARD-A', 100);
const B = await featuredCard('CARD-B', 100);
const C = await featuredCard('CARD-C', 100);
await seedGamePool(db, 1_000_000);

test('entering drafts a roster under the cap, charges the entry, and balances', async () => {
  await cfg(2, 300, 25);
  const u1 = await newUser();
  const v = await enterFantasy(db, u1, [A, B], randomUUID());
  assert.equal(v.entrantCount, 1);
  assert.equal(v.yourEntry?.roster.length, 2);
  assert.equal((await getUserBalances(db, u1)).availableUusdc, usdc(10_000) - usdc(25), 'entry charged');
  assert.ok((await reconcile(db)).ok);
  await settleLeagueNow(v.leagueId); // cleanup → refunds u1 (only 1 < minEntries 2)
});

test('a roster over the salary cap is rejected and nothing is charged', async () => {
  await cfg(2, 150, 25); // cap $150 < a $200 roster
  const u1 = await newUser();
  await assert.rejects(enterFantasy(db, u1, [A, B], randomUUID()), /cap/);
  assert.equal((await getUserBalances(db, u1)).availableUusdc, usdc(10_000), 'not charged');
});

test('a wrong-size or duplicate roster is rejected', async () => {
  await cfg(2, 300, 25);
  const u1 = await newUser();
  await assert.rejects(enterFantasy(db, u1, [A], randomUUID()), /exactly 2/);
  await assert.rejects(enterFantasy(db, u1, [A, A], randomUUID()), /distinct/);
});

test('a user can only enter a league once', async () => {
  await cfg(2, 300, 25);
  const u1 = await newUser();
  const v = await enterFantasy(db, u1, [A, B], randomUUID());
  await assert.rejects(enterFantasy(db, u1, [A, C], randomUUID()), /already entered/);
  await settleLeagueNow(v.leagueId);
});

test('the top %-move roster takes the pool minus rake; the rest get nothing', async () => {
  await cfg(2, 300, 25, 1000); // rake 10%
  const u1 = await newUser();
  const u2 = await newUser();
  const v = await enterFantasy(db, u1, [A, B], randomUUID()); // entry marks $100 each
  await enterFantasy(db, u2, [A, C], randomUUID());
  // movement, backdated before the forced close: A +50%, B +20%, C +5%
  await markPast(A, 150, '30 minutes');
  await markPast(B, 120, '30 minutes');
  await markPast(C, 105, '30 minutes');
  await settleLeagueNow(v.leagueId);
  // u1 [A,B] = 70% beats u2 [A,C] = 55%. pool $50, rake 10% → payout $45.
  const res = await getLeague(db, u1, v.leagueId);
  assert.equal(res?.status, 'settled');
  assert.equal(res?.yourEntry?.prizeE6, usdc(45).toString());
  assert.equal((await getUserBalances(db, u1)).availableUusdc, usdc(10_000) - usdc(25) + usdc(45), 'winner');
  assert.equal((await getUserBalances(db, u2)).availableUusdc, usdc(10_000) - usdc(25), 'loser keeps nothing');
  assert.ok((await reconcile(db)).ok);
});

test('a league below minEntries refunds everyone, no rake', async () => {
  await cfg(2, 300, 25, 1000, 3); // minEntries 3
  const u1 = await newUser();
  const u2 = await newUser();
  const v = await enterFantasy(db, u1, [A, B], randomUUID());
  await enterFantasy(db, u2, [A, C], randomUUID()); // 2 entrants < 3
  await settleLeagueNow(v.leagueId);
  const res = await getLeague(db, u1, v.leagueId);
  assert.equal(res?.refunded, true);
  assert.equal((await getUserBalances(db, u1)).availableUusdc, usdc(10_000), 'u1 refunded');
  assert.equal((await getUserBalances(db, u2)).availableUusdc, usdc(10_000), 'u2 refunded');
  assert.ok((await reconcile(db)).ok);
});

test('entering is idempotent — the same key does not charge twice', async () => {
  await cfg(2, 300, 25);
  const u1 = await newUser();
  const key = randomUUID();
  const a = await enterFantasy(db, u1, [A, B], key);
  const b = await enterFantasy(db, u1, [A, B], key);
  assert.equal(b.leagueId, a.leagueId);
  assert.equal((await getUserBalances(db, u1)).availableUusdc, usdc(10_000) - usdc(25), 'charged once');
  await settleLeagueNow(a.leagueId);
});

test('the next entry settles an expired league and opens a fresh one', async () => {
  await cfg(2, 300, 25);
  const u1 = await newUser();
  const first = await enterFantasy(db, u1, [A, B], randomUUID());
  await forceClose(first.leagueId); // close the window but do NOT settle — the next entry must settle it
  const u2 = await newUser();
  const second = await enterFantasy(db, u2, [A, C], randomUUID());
  assert.notEqual(second.leagueId, first.leagueId, 'a new league id');
  assert.equal(second.entrantCount, 1, 'fresh league starts empty');
  assert.equal((await getLeague(db, u1, first.leagueId))?.status, 'settled', 'the prior league settled on the next entry');
  await settleLeagueNow(second.leagueId);
});

test('a roster whose size does not match the league snapshot is rejected', async () => {
  await cfg(3, 600, 25); // a 3-card league
  const u1 = await newUser();
  await assert.rejects(enterFantasy(db, u1, [A, B], randomUUID()), /exactly 3/, 'too few cards for the league');
});
