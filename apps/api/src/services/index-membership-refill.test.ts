import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// Decisions B + C (2026-10-19): a member leaving between change dates is replaced at once from the cards that may join
// now (never one that left since the last change, R11); a basket that loses every member stays governed — it refills
// as a fresh start (the R11 bar lifted) when it can, and otherwise holds its level, never the old top-N re-slice.
process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { upsertCardMarket, upsertIndexMarket } = await import('./markets.ts');
const { writeIndexSnapshot } = await import('./oracle.ts');
const { runIndexRules, retireIndexRules, loadMembershipRows, membershipAsOf, indexBasketView } = await import('./index-membership.ts');
const { buildBaskets } = await import('./index-baskets.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

const D = (iso: string) => new Date(iso);
const ids = new Map<number, string>();
for (const [i, usd] of [[1, 100], [2, 90], [3, 80], [4, 40], [5, 30], [6, 20]] as const) {
  const id = await upsertCardMarket(db, {
    game: 'pokemon', symbol: `pokemon:rf${i}`, cardId: `rf${i}`, displayName: `RF${i} #1`, variant: null, imageSmall: null,
    featured: true, productType: 'single', tcgplayerId: 910_000 + i,
  });
  ids.set(i, id);
  for (const at of ['2026-09-01T00:00:00Z', '2026-10-01T12:00:00Z']) {
    await db.query(`INSERT INTO oracle_prices(market_id, index_price_e6, source_observed_at, ingested_at) VALUES($1, $2, $3, $3)`, [id, usd * 1_000_000, at]);
  }
}
const gj = await db.tx((q) => upsertIndexMarket(q, { game: 'pokemon', slug: 'top-100', name: 'Top 100', tradeable: true }));
await writeIndexSnapshot(db, gj, [1, 2, 3].map((i) => ({ cardId: `rf${i}`, priceE6: BigInt(i) })));
const exclude = (i: number) => db.query(`INSERT INTO index_exclusions(market_id, reason) VALUES($1, 'test') ON CONFLICT DO NOTHING`, [ids.get(i)]);
const clear = (i: number) => db.query(`DELETE FROM index_exclusions WHERE market_id = $1`, [ids.get(i)]);
const open = async () =>
  (await db.query<{ n: string; why: string }>(
    `SELECT replace(m.symbol, 'pokemon:rf', '') AS n, im.join_reason AS why FROM index_members im JOIN markets m ON m.id = im.market_id
      WHERE im.basket = 'pokemon:top-100' AND im.left_at IS NULL ORDER BY m.symbol`,
  )).rows.map((r) => `${r.n}:${r.why}`);

test('B: a leaver is replaced at once by the best card that may join; a card that left since the last change is not', async () => {
  await runIndexRules(db, D('2026-10-02T00:00:00Z'));
  assert.deepEqual(await open(), ['1:launch', '2:launch', '3:launch']);
  await exclude(2);
  await runIndexRules(db, D('2026-10-02T06:00:00Z'));
  assert.deepEqual(await open(), ['1:launch', '3:launch', '4:refill'], 'card 2 out (by hand), the best that may join (4) in');
  await clear(2); // card 2 may join again — but it left this period: back only at a change date (R11)
  await exclude(4);
  await runIndexRules(db, D('2026-10-02T12:00:00Z'));
  assert.deepEqual(await open(), ['1:launch', '3:launch', '5:refill'], '5, not the dearer 2');
});

test('C: a basket that loses every member stays governed — empty it holds its level, then refills as a fresh start', async () => {
  for (const i of [1, 2, 3, 4, 5, 6]) await exclude(i);
  await runIndexRules(db, D('2026-10-02T18:00:00Z'));
  assert.deepEqual(await open(), [], 'every member out, and nobody may join');
  const members = membershipAsOf(await loadMembershipRows(db), D('2026-10-02T18:00:00Z'));
  assert.deepEqual([...(members.get('pokemon:top-100') ?? ['absent'])], [], 'still governed, with no members');
  const cards = [1, 2, 3, 4, 5, 6].map((i) => ({ game: 'pokemon', cardId: `rf${i}`, priceE6: 1_000_000n, gradedE6: null, productType: 'single' as const, eligible: true }));
  const top = buildBaskets(cards, { gradedConstituents: 100, sealedEnabled: false, sealedMin: 5, members }).find((b) => b.idx.slug === 'top-100')!;
  assert.equal(top.members.length, 0, 'no fallback to the old top-N rule');
  await clear(6);
  await runIndexRules(db, D('2026-10-02T20:00:00Z'));
  assert.deepEqual(await open(), ['6:restart'], 'refills as soon as a card may join');
  await clear(1);
  await clear(2);
  await runIndexRules(db, D('2026-10-02T20:30:00Z'));
  assert.deepEqual(await open(), ['1:refill', '2:refill', '6:restart'], 'cards that left before the fresh start are not barred');
});

test('C: switching the rules off ends an EMPTY governed basket too (old rule again); switching on relaunches it', async () => {
  for (const i of [1, 2, 3, 4, 5, 6]) await exclude(i);
  await runIndexRules(db, D('2026-10-02T21:00:00Z'));
  assert.deepEqual(await open(), []);
  await retireIndexRules(db, D('2026-10-02T22:00:00Z'));
  const after = membershipAsOf(await loadMembershipRows(db), D('2026-10-02T22:30:00Z'));
  assert.equal(after.has('pokemon:top-100'), false, 'not governed once switched off: the old rule (and the rebuild agrees)');
  assert.equal((await indexBasketView(db, 'INDEX:top-100'))?.governed, false);
  await retireIndexRules(db, D('2026-10-02T23:00:00Z'));
  assert.equal((await db.query(`SELECT 1 FROM index_rules_off`)).rows.length, 1, 'idempotent: one marker');
  for (const i of [1, 2, 3, 4, 5, 6]) await clear(i);
  await runIndexRules(db, D('2026-10-02T23:30:00Z')); // switched on again: launches from the live basket (R10)
  assert.deepEqual(await open(), ['1:launch', '2:launch', '3:launch']);
});

test('era: after a switch-off and relaunch, earlier-era leavers are not barred (R11 counts this era only)', async () => {
  for (const i of [1, 2, 3, 4, 5, 6]) await db.query(`INSERT INTO oracle_prices(market_id, index_price_e6, source_observed_at, ingested_at) VALUES($1, $2, $3, $3)`, [ids.get(i), [100, 90, 80, 40, 30, 20][i - 1] * 1_000_000, '2026-10-02T23:45:00Z']);
  for (const i of [5, 6]) await exclude(i); // keep 5 and 6 out of the way: 4 is the best non-member that may join
  await runIndexRules(db, D('2026-10-03T00:00:00Z'));
  assert.deepEqual(await open(), ['1:launch', '2:launch', '3:launch']);
  await exclude(1);
  await runIndexRules(db, D('2026-10-03T01:00:00Z'));
  assert.deepEqual(await open(), ['2:launch', '3:launch', '4:refill'], '4 left only in the earlier era: it may refill');
});

test('B: a basket that shrank while nothing could join refills on a later pass, back to its size', async () => {
  await exclude(2);
  await runIndexRules(db, D('2026-10-03T02:00:00Z'));
  assert.deepEqual(await open(), ['3:launch', '4:refill'], '2 out; 1, 5, 6 excluded — nobody may join');
  await clear(5);
  await runIndexRules(db, D('2026-10-03T03:00:00Z'));
  assert.deepEqual(await open(), ['3:launch', '4:refill', '5:refill'], 'back to 3 members once 5 may join');
  await clear(6);
  await runIndexRules(db, D('2026-10-03T04:00:00Z'));
  assert.deepEqual(await open(), ['3:launch', '4:refill', '5:refill'], 'never past its size');
});

test('C after an outage: every member staled out, prices return → the real top cards come back at once (fresh start)', async () => {
  for (const i of [1, 2, 3, 4, 5, 6]) await clear(i);
  const members = async () => (await open()).length;
  const before = await members();
  assert.ok(before > 0);
  // 15 days with no price at all: every member leaves for "stale", nobody may join
  await runIndexRules(db, D('2026-10-18T06:00:00Z'));
  assert.deepEqual(await open(), []);
  // prices return for every card
  for (const i of [1, 2, 3, 4, 5, 6]) await db.query(`INSERT INTO oracle_prices(market_id, index_price_e6, source_observed_at, ingested_at) VALUES($1, $2, $3, $3)`, [ids.get(i), [100, 90, 80, 40, 30, 20][i - 1] * 1_000_000, '2026-10-18T07:00:00Z']);
  await runIndexRules(db, D('2026-10-18T08:00:00Z'));
  // a fresh start takes the best that may join, up to N (100) — like a launch, so here every card; the bar is lifted
  assert.deepEqual(await open(), ['1:restart', '2:restart', '3:restart', '4:restart', '5:restart', '6:restart']);
});
