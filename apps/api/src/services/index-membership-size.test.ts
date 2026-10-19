import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Decision B's size, end to end (2026-10-19 review): a published change records the size of the basket it describes;
// until it applies, refills stop at what the basket will hold AFTER it (its adds counted in, its removes out), and
// when it applies that size is kept — a gap still open then is refilled, not written off. A fresh start's own leavers
// may come back on later passes (C).
process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.GRADED_CONSTITUENTS = '3';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { upsertCardMarket, upsertIndexMarket } = await import('./markets.ts');
const { writeIndexSnapshot } = await import('./oracle.ts');
const { runIndexRules, indexBasketView } = await import('./index-membership.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

const D = (iso: string) => new Date(iso);
const PRICE: Record<number, number> = { 1: 100, 2: 90, 3: 80, 4: 70, 5: 60, 6: 50 };
const CARDS = [1, 2, 3, 4, 5, 6];
const ids = new Map<number, string>();
for (const i of CARDS) {
  const id = await upsertCardMarket(db, {
    game: 'pokemon', symbol: `pokemon:sz${i}`, cardId: `sz${i}`, displayName: `SZ${i} #1`, variant: null, imageSmall: null,
    featured: true, productType: 'single', tcgplayerId: 930_000 + i,
  });
  ids.set(i, id);
  await db.query(`UPDATE markets SET graded_psa10_e6 = $2 WHERE id = $1`, [id, PRICE[i] * 3_000_000]);
}
const gj = await db.tx((q) => upsertIndexMarket(q, { game: 'pokemon', slug: 'graded', name: 'Graded', tradeable: true }));
await writeIndexSnapshot(db, gj, [1, 2, 3].map((i) => ({ cardId: `sz${i}`, priceE6: BigInt(PRICE[i]) })));

const print = async (iso: string, cards = CARDS) => {
  for (const i of cards) {
    await db.query(`INSERT INTO oracle_prices(market_id, index_price_e6, source_observed_at, ingested_at) VALUES($1, $2, $3, $3)`, [ids.get(i), PRICE[i] * 1_000_000, iso]);
  }
};
const hour = (iso: string) => new Date(D(iso).getTime() - 3_600_000).toISOString();
const pass = async (iso: string, cards = CARDS) => {
  await print(hour(iso), cards);
  await runIndexRules(db, D(iso));
};
const lowConf = (cards: number[], v: boolean) => db.query(`UPDATE markets SET low_confidence = $2 WHERE id = ANY($1)`, [cards.map((i) => ids.get(i)), v]);
const exclude = (i: number) => db.query(`INSERT INTO index_exclusions(market_id, reason) VALUES($1, 'test') ON CONFLICT DO NOTHING`, [ids.get(i)]);
const announce = (date: string, size: number, adds: number[], removes: number[], reserves: number[] = []) =>
  db.query(
    `INSERT INTO index_changes(basket, change_date, reference_at, published_at, effective_at, adds, removes, reserves, size)
     VALUES('pokemon:graded', $1::date, $1::date, $1::date, $1::date + interval '3 days 1 hour', $2, $3, $5, $4)`,
    [date, adds.map((i) => ids.get(i)), JSON.stringify(removes.map((i) => ({ marketId: ids.get(i), reason: 'rank' }))), size, reserves.map((i) => ids.get(i))],
  );
const clearEx = (i: number) => db.query(`DELETE FROM index_exclusions WHERE market_id = $1`, [ids.get(i)]);
const open = async () =>
  (await db.query<{ n: string; why: string }>(
    `SELECT replace(m.symbol, 'pokemon:sz', '') AS n, im.join_reason AS why FROM index_members im JOIN markets m ON m.id = im.market_id
      WHERE im.basket = 'pokemon:graded' AND im.left_at IS NULL ORDER BY m.symbol`,
  )).rows.map((r) => `${r.n}:${r.why}`);

beforeEach(async () => {
  for (const t of ['index_members', 'index_changes', 'index_basket_size', 'index_exclusions', 'index_rules_off', 'oracle_prices']) await db.query(`DELETE FROM ${t}`);
  await db.query(`UPDATE markets SET low_confidence = false WHERE id = ANY($1)`, [[...ids.values()]]);
  await print('2026-08-01T00:00:00Z'); // seasoned by September
  await pass('2026-09-02T06:00:00Z');
  assert.deepEqual(await open(), ['1:launch', '2:launch', '3:launch']);
});

test('a change that fills a gap keeps its slot: no refill takes it before the apply, and the add joins', async () => {
  await lowConf([4, 5, 6], true);
  await exclude(3);
  await pass('2026-09-17T06:00:00Z');
  assert.deepEqual(await open(), ['1:launch', '2:launch'], 'a gap nobody may fill yet');
  await announce('2026-10-01', 3, [4], []); // the change fills it with 4
  await lowConf([4, 5, 6], false);
  await pass('2026-10-02T06:00:00Z');
  assert.deepEqual(await open(), ['1:launch', '2:launch'], 'not 5: the slot is the announced add\'s');
  await pass('2026-10-04T06:00:00Z');
  assert.deepEqual(await open(), ['1:launch', '2:launch', '4:change']);
});

test('a gap still open when a change applies is refilled afterwards — the change\'s size is kept', async () => {
  await announce('2026-10-01', 3, [], []);
  await lowConf([4, 5, 6], true);
  await exclude(2);
  await pass('2026-10-02T06:00:00Z');
  assert.deepEqual(await open(), ['1:launch', '3:launch']);
  await pass('2026-10-04T06:00:00Z'); // applies, the gap still open
  await lowConf([5], false);
  await pass('2026-10-05T06:00:00Z');
  assert.deepEqual(await open(), ['1:launch', '3:launch', '5:refill']);
});

test('a fresh start\'s own leavers come back on a later pass, as cards return after an outage', async () => {
  await print('2026-09-03T00:00:00Z'); // the last price for 1–3
  await pass('2026-09-17T06:00:00Z', [4]); // 1–3 stale and out; only 4 is fresh → a fresh start with 4
  assert.deepEqual(await open(), ['4:restart']);
  await pass('2026-09-18T06:00:00Z'); // every price is back
  assert.deepEqual(await open(), ['1:refill', '2:refill', '4:restart'], 'the best that may join, not 5 and 6');
});

test('a fresh start during a pending change keeps aiming for N on later passes (not the change\'s smaller size)', async () => {
  await announce('2026-09-15', 2, [], [3]); // a change that shrinks the basket to 2, applying the 18th
  await print('2026-09-03T00:00:00Z');
  await pass('2026-09-17T06:00:00Z', [4]); // 1–3 stale and out; only 4 fresh → a fresh start
  assert.deepEqual(await open(), ['4:restart']);
  await pass('2026-09-17T12:00:00Z'); // prices back, the change still pending
  assert.deepEqual(await open(), ['1:refill', '2:refill', '4:restart'], 'up to N; never 3, which the change announces out');
});

test('a reserve the apply refuses (it left since the publish) does not slip in the same pass as a refill', async () => {
  await announce('2026-10-01', 3, [4], [3], [5]);
  await exclude(2);
  await pass('2026-10-02T06:00:00Z');
  assert.deepEqual(await open(), ['1:launch', '3:launch', '5:reserve']);
  await exclude(5);
  await pass('2026-10-03T06:00:00Z');
  assert.deepEqual(await open(), ['1:launch', '3:launch', '6:refill'], '5 out; 6 in (4 waits for the apply)');
  await clearEx(5);
  await clearEx(2);
  await lowConf([4], true);
  await pass('2026-10-04T06:00:00Z'); // 3 out as announced; 4 can't join; 5 and 2 left since the publish → barred
  assert.deepEqual(await open(), ['1:launch', '6:refill']);
});
