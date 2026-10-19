import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// Decision B against an announced change (2026-10-19 review): between the publish and the apply, a refill never takes
// one of the change's adds (they join at apply, with notice — R1) nor another printing of one (R12); the change's
// intended size is kept, so a shortfall at apply is topped up the same pass; and a change applied to an EMPTY basket
// (an outage) doesn't stop the fresh start once prices return (C). A Graded basket of 3 keeps it small.
process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.GRADED_CONSTITUENTS = '3';
process.env.PRINTING_MARKETS_ENABLED = 'true';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { upsertCardMarket, upsertIndexMarket } = await import('./markets.ts');
const { writeIndexSnapshot } = await import('./oracle.ts');
const { runIndexRules, indexBasketView } = await import('./index-membership.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

const D = (iso: string) => new Date(iso);
const PRICE: Record<number, number> = { 1: 100, 2: 90, 3: 80, 4: 70, 5: 60, 6: 50, 7: 55 };
const ids = new Map<number, string>();
for (const i of [1, 2, 3, 4, 5, 6, 7]) {
  // g7 is another printing of g4's product (same TCGplayer id)
  const id = await upsertCardMarket(db, {
    game: 'pokemon', symbol: `pokemon:pd${i}`, cardId: `pd${i}`, displayName: `PD${i} #1`, variant: i === 7 ? 'Reverse Holofoil' : 'Holofoil',
    imageSmall: null, featured: true, productType: 'single', tcgplayerId: 920_000 + (i === 7 ? 4 : i),
  });
  ids.set(i, id);
  await db.query(`UPDATE markets SET graded_psa10_e6 = $2 WHERE id = $1`, [id, PRICE[i] * 3_000_000]);
}
const printAll = async (iso: string) => {
  for (const [i, id] of ids) {
    await db.query(`INSERT INTO oracle_prices(market_id, index_price_e6, source_observed_at, ingested_at) VALUES($1, $2, $3, $3)`, [id, PRICE[i] * 1_000_000, iso]);
  }
};
await printAll('2026-08-01T00:00:00Z'); // seasoned (30 days) by the launch
const gj = await db.tx((q) => upsertIndexMarket(q, { game: 'pokemon', slug: 'graded', name: 'Graded', tradeable: true }));
await writeIndexSnapshot(db, gj, [1, 2, 3].map((i) => ({ cardId: `pd${i}`, priceE6: BigInt(PRICE[i]) })));

const set = (col: 'low_confidence', i: number, v: boolean) => db.query(`UPDATE markets SET ${col} = $2 WHERE id = $1`, [ids.get(i), v]);
const exclude = (i: number) => db.query(`INSERT INTO index_exclusions(market_id, reason) VALUES($1, 'test') ON CONFLICT DO NOTHING`, [ids.get(i)]);
const announce = (date: string, effective: string, adds: number[], removes: number[], reserves: number[]) =>
  db.query(
    `INSERT INTO index_changes(basket, change_date, reference_at, published_at, effective_at, adds, removes, reserves) VALUES('pokemon:graded', $1::date, $1::date, $1::date, $2, $3, $4, $5)`,
    [date, effective, adds.map((i) => ids.get(i)), JSON.stringify(removes.map((i) => ({ marketId: ids.get(i), reason: 'rank' }))), reserves.map((i) => ids.get(i))],
  );
const pass = async (iso: string) => {
  await printAll(new Date(D(iso).getTime() - 3_600_000).toISOString());
  await runIndexRules(db, D(iso));
};
const open = async () =>
  (await db.query<{ n: string; why: string }>(
    `SELECT replace(m.symbol, 'pokemon:pd', '') AS n, im.join_reason AS why FROM index_members im JOIN markets m ON m.id = im.market_id
      WHERE im.basket = 'pokemon:graded' AND im.left_at IS NULL ORDER BY m.symbol`,
  )).rows.map((r) => `${r.n}:${r.why}`);

test('a refill before the apply never takes an announced add, nor another printing of one; the add joins at apply', async () => {
  await pass('2026-09-20T06:00:00Z');
  assert.deepEqual(await open(), ['1:launch', '2:launch', '3:launch']);
  await announce('2026-10-01', '2026-10-04T01:00:00Z', [4], [3], [5]);
  await exclude(1);
  await set('low_confidence', 5, true); // the reserve can't join now
  await pass('2026-10-02T06:00:00Z');
  assert.deepEqual(await open(), ['2:launch', '3:launch', '6:refill'], 'not 4 (announced, waits for its notice), not 7 (4\'s other printing)');
  await set('low_confidence', 5, false);
  await pass('2026-10-04T06:00:00Z');
  assert.deepEqual(await open(), ['2:launch', '4:change', '6:refill'], '3 out and 4 in, as announced');
  const log = (await indexBasketView(db, 'INDEX:graded'))!.log[0];
  assert.deepEqual([log.adds.map((a) => a.name), log.notJoined.length], [['PD4 #1'], 0]);
});

test('an add that cannot join at apply leaves a gap the same pass tops up (the change\'s intended size is kept)', async () => {
  await announce('2026-11-01', '2026-11-04T01:00:00Z', [5], [6], []);
  await set('low_confidence', 5, true);
  await pass('2026-11-04T06:00:00Z');
  // 6 out as announced; 5 can't join and there is no reserve → the best that may join (3; 1 is excluded, 7 is 4's printing)
  assert.deepEqual(await open(), ['2:launch', '3:refill', '4:change']);
  assert.equal((await db.query<{ size: number }>(`SELECT size FROM index_basket_size WHERE basket = 'pokemon:graded'`)).rows[0].size, 3);
});

test('a change applied while an outage has emptied the basket: the fresh start still comes once prices return', async () => {
  await runIndexRules(db, D('2026-11-20T06:00:00Z')); // no price since 4 Nov: every member stale, nobody may join
  assert.deepEqual(await open(), []);
  await announce('2026-12-01', '2026-12-04T01:00:00Z', [], [], []);
  await runIndexRules(db, D('2026-12-04T06:00:00Z')); // applies with nothing to add, the outage still on
  assert.deepEqual(await open(), []);
  await pass('2026-12-05T06:00:00Z'); // prices return
  assert.deepEqual(await open(), ['2:restart', '3:restart', '4:restart'], 'the best 3 that may join (1 is excluded, 5 low-confidence)');
});
