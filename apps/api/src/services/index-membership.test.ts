import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// Index rules v3 against the DB (2026-10-18 plan R1–R12): launch from the live basket, a monthly change published on
// the 1st and applied from the 4th, the 30-day wait, removal for a cause replaced from the reserves, and the locks.
process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { upsertCardMarket, upsertIndexMarket } = await import('./markets.ts');
const { writeIndexSnapshot } = await import('./oracle.ts');
const { runIndexRules, monthSchedule } = await import('./index-membership.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

const D = (iso: string) => new Date(iso);
const ids = new Map<number, string>(); // card number → market id
async function addCard(i: number, usd: number, firstAt: Date) {
  const id = await upsertCardMarket(db, {
    game: 'pokemon', symbol: `pokemon:v${i}`, cardId: `v${i}`, displayName: `V${i} #1`, variant: null, imageSmall: null,
    featured: true, productType: 'single', tcgplayerId: 900_000 + i,
  });
  ids.set(i, id);
  await price(i, usd, firstAt);
}
async function price(i: number, usd: number, at: Date) {
  await db.query(
    `INSERT INTO oracle_prices(market_id, index_price_e6, source_observed_at, ingested_at) VALUES($1, $2, $3, $3)`,
    [ids.get(i), BigInt(Math.round(usd * 1e6)).toString(), at],
  );
}
const members = async () =>
  (await db.query<{ market_id: string }>(`SELECT market_id FROM index_members WHERE basket = 'pokemon:top-100' AND left_at IS NULL`)).rows.map((r) => r.market_id);
const num = (marketId: string) => [...ids].find(([, id]) => id === marketId)![0];

test('R1 schedule: reference 00:00 UTC on the 1st, earliest effective the 4th', () => {
  const s = monthSchedule(D('2026-11-17T09:00:00Z'));
  assert.equal(s.changeDate, '2026-11-01');
  assert.equal(s.referenceAt.toISOString(), '2026-11-01T00:00:00.000Z');
  assert.equal(s.earliestEffective.toISOString(), '2026-11-04T00:00:00.000Z');
});

test('launch, a monthly change at the 90/110 edges, the 30-day wait, cause removal + reserve, and the locks', async () => {
  // 115 seasoned cards, card i ranked i (price 1000 − i); the live Top-100 basket = cards 1–100.
  for (let i = 1; i <= 115; i++) await addCard(i, 1000 - i, D('2026-08-01T00:00:00Z'));
  const idx = await db.tx((q) => upsertIndexMarket(q, { game: 'pokemon', slug: 'top-100', name: 'GJ Top 100', tradeable: true }));
  await db.tx((q) => writeIndexSnapshot(q, idx, Array.from({ length: 100 }, (_, k) => ({ cardId: `v${k + 1}`, priceE6: BigInt(1000 - k - 1) * 1_000_000n }))));

  // R10 launch mid-September: members = the live basket, and no change for September (launched after its 1st).
  for (let i = 1; i <= 115; i++) await price(i, 1000 - i, D('2026-09-20T00:00:00Z'));
  await runIndexRules(db, D('2026-09-20T06:00:00Z'));
  assert.deepEqual((await members()).map(num).sort((a, b) => a - b), Array.from({ length: 100 }, (_, k) => k + 1));
  assert.equal((await db.query(`SELECT 1 FROM index_changes`)).rows.length, 0, 'the first change date is the next 1st');

  // Prices for the 1 October reference: 105 jumps to the top, member 50 falls to the bottom, and a brand-new card
  // 120 is priciest of all but only 6 days old (R3: 30-day wait).
  for (let i = 1; i <= 115; i++) await price(i, i === 105 ? 5000 : i === 50 ? 880 : 1000 - i, D('2026-09-30T20:00:00Z'));
  await addCard(120, 9999, D('2026-09-25T00:00:00Z'));
  await runIndexRules(db, D('2026-10-01T06:00:00Z'));
  const ch = (await db.query<{ adds: string[]; removes: { marketId: string; reason: string }[]; reserves: string[]; effective_at: Date }>(
    `SELECT adds, removes, reserves, effective_at FROM index_changes WHERE basket = 'pokemon:top-100'`,
  )).rows[0];
  assert.deepEqual(ch.adds.map(num), [105], 'rank 2 joins; the unseasoned #1 may not');
  assert.deepEqual(ch.removes.map((r) => [num(r.marketId), r.reason]), [[50, 'rank']], 'rank 116 > stay 110');
  assert.ok(!ch.reserves.map(num).includes(120), 'an unseasoned card is no reserve either');
  assert.equal(new Date(ch.effective_at).toISOString(), '2026-10-04T06:00:00.000Z', 'max(the 4th, published + 72 h)');

  // R7: an announced addition and the reserves are locked while it is pending.
  const locked = new Set((await db.query<{ market_id: string }>(`SELECT market_id FROM index_locked_markets`)).rows.map((r) => r.market_id));
  assert.ok(locked.has(ids.get(105)!) && locked.has(ids.get(ch.reserves.length ? num(ch.reserves[0]) : 0)!));

  // Not yet effective on the 3rd; applied at the first run at/after 4 Oct 06:00 (adds re-checked: still fresh).
  await runIndexRules(db, D('2026-10-03T06:00:00Z'));
  assert.ok(!(await members()).includes(ids.get(105)!));
  for (let i = 1; i <= 115; i++) await price(i, i === 105 ? 5000 : i === 50 ? 880 : 1000 - i, D('2026-10-03T20:00:00Z'));
  await runIndexRules(db, D('2026-10-04T06:00:00Z'));
  const after = (await members()).map(num);
  assert.ok(after.includes(105) && !after.includes(50) && after.length === 100);
  await runIndexRules(db, D('2026-10-04T12:00:00Z'));
  assert.equal((await members()).length, 100, 'a second run applies nothing twice');

  // R5 between dates: member 2 is delisted → it leaves, and the best reserve that may join replaces it (D3).
  await db.query(`UPDATE markets SET status = 'delisted' WHERE id = $1`, [ids.get(2)]);
  await runIndexRules(db, D('2026-10-05T06:00:00Z'));
  const m2 = (await members()).map(num);
  assert.ok(!m2.includes(2));
  assert.equal(m2.length, 100);
  const left = (await db.query<{ leave_reason: string }>(`SELECT leave_reason FROM index_members WHERE market_id = $1`, [ids.get(2)])).rows[0];
  assert.equal(left.leave_reason, 'delisted');

  // R11: removed by hand → leaves at the next run and does not come back while excluded.
  await db.query(`INSERT INTO index_exclusions(market_id, reason) VALUES($1, 'fake sale')`, [ids.get(3)]);
  await runIndexRules(db, D('2026-10-05T12:00:00Z'));
  assert.ok(!(await members()).map(num).includes(3));
});

const count = async () => (await members()).length;

test('a re-claimed change applies nothing twice (adds already in count as done)', async () => {
  // (continues the scenario above) — simulate a second pass claiming the already-applied October change
  await db.query(`UPDATE index_changes SET applied_at = NULL WHERE basket = 'pokemon:top-100' AND change_date = '2026-10-01'`);
  const before = await count();
  await runIndexRules(db, D('2026-10-06T06:00:00Z'));
  assert.equal(await count(), before, 'no reserve is added for an add that is already a member');
});

test('a member the announced change removes leaves early for a cause: not replaced, so the basket never exceeds N', async () => {
  // November: member 60 falls to the bottom (announced remove), non-member 115 jumps to the top (announced add)
  for (let i = 1; i <= 115; i++) if (i !== 2) await price(i, i === 115 ? 6000 : i === 60 ? 870 : i === 105 ? 5000 : 1000 - i, D('2026-10-31T20:00:00Z'));
  await runIndexRules(db, D('2026-11-01T06:00:00Z'));
  const nov = (await db.query<{ adds: string[]; removes: { marketId: string }[] }>(`SELECT adds, removes FROM index_changes WHERE change_date = '2026-11-01' AND basket = 'pokemon:top-100'`)).rows[0];
  assert.ok(nov.removes.some((r) => num(r.marketId) === 60) && nov.adds.map(num).includes(115));
  const n0 = await count();
  await db.query(`UPDATE markets SET status = 'delisted' WHERE id = $1`, [ids.get(60)]);
  for (let i = 1; i <= 115; i++) if (![2, 60].includes(i)) await price(i, i === 115 ? 6000 : i === 105 ? 5000 : 1000 - i, D('2026-11-02T00:00:00Z'));
  await runIndexRules(db, D('2026-11-02T06:00:00Z'));
  assert.equal(await count(), n0 - 1, 'left for its cause, slot kept for the announced add');
  for (let i = 1; i <= 115; i++) if (![2, 60].includes(i)) await price(i, i === 115 ? 6000 : i === 105 ? 5000 : 1000 - i, D('2026-11-03T20:00:00Z'));
  await runIndexRules(db, D('2026-11-04T06:00:00Z'));
  assert.ok((await count()) <= 100, 'never N + 1');
  assert.ok((await members()).map(num).includes(115), 'the announced add joined');
});

test('switching the rules off closes the lists and the locks; switching on relaunches from the live basket', async () => {
  const { retireIndexRules } = await import('./index-membership.ts');
  await retireIndexRules(db, D('2026-11-05T00:00:00Z'));
  assert.equal(await count(), 0);
  assert.equal((await db.query(`SELECT 1 FROM index_locked_markets`)).rows.length, 0, 'nothing stays locked');
  await runIndexRules(db, D('2026-11-06T00:00:00Z'));
  const relaunched = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM index_members WHERE basket = 'pokemon:top-100' AND join_reason = 'launch' AND joined_at = '2026-11-06T00:00:00Z'`,
  );
  assert.equal(relaunched.rows[0].n, 100, 'relaunched from the GJ snapshot (cards 1–100), not the stale list');
  // the same pass then removes the members with a cause (2 and 60 delisted, 3 removed by hand)
  assert.ok(!(await members()).map(num).some((i) => [2, 3, 60].includes(i)));
});

test('Graded: a missing PSA-10 removes a member only after 14 days; non-members without a PSA-10 are not ranked', async () => {
  const g = await db.tx((q) => upsertIndexMarket(q, { game: 'pokemon', slug: 'graded', name: 'GJ Graded', tradeable: true }));
  await db.tx((q) => writeIndexSnapshot(q, g, [5, 6, 7].map((i) => ({ cardId: `v${i}`, priceE6: 5_000_000_000n }))));
  for (const i of [5, 6, 7]) await db.query(`INSERT INTO graded_prints(market_id, graded_e6, observed_at) VALUES($1, 5000000000, '2026-09-01T00:00:00Z')`, [ids.get(i)]);
  const gm = async () =>
    (await db.query<{ market_id: string }>(`SELECT market_id FROM index_members WHERE basket = 'pokemon:graded' AND left_at IS NULL`)).rows.map((r) => num(r.market_id)).sort((a, b) => a - b);
  for (let i = 1; i <= 115; i++) if (![2, 60].includes(i)) await price(i, 1000 - i, D('2026-11-20T00:00:00Z'));
  await runIndexRules(db, D('2026-11-20T06:00:00Z'));
  assert.deepEqual(await gm(), [5, 6, 7]);
  await db.query(`INSERT INTO graded_prints(market_id, graded_e6, observed_at) VALUES($1, NULL, '2026-11-21T00:00:00Z')`, [ids.get(5)]);
  for (let i = 1; i <= 115; i++) if (![2, 60].includes(i)) await price(i, 1000 - i, D('2026-11-21T00:00:00Z'));
  await runIndexRules(db, D('2026-11-21T00:00:01Z'));
  assert.deepEqual(await gm(), [5, 6, 7], 'a one-pass PSA-10 blip is not a cause (the old value was set long ago)');
  for (let i = 1; i <= 115; i++) if (![2, 60].includes(i)) await price(i, 1000 - i, D('2026-12-05T00:00:00Z'));
  await runIndexRules(db, D('2026-12-05T06:00:00Z'));
  assert.ok(!(await gm()).includes(5), 'missing 14 days → removed');
  const dec = (await db.query<{ adds: string[] }>(`SELECT adds FROM index_changes WHERE change_date = '2026-12-01' AND basket = 'pokemon:graded'`)).rows[0];
  const withPsa10 = new Set([5, 6, 7]);
  assert.ok(!dec || dec.adds.every((id) => withPsa10.has(num(id))), 'no card without a PSA-10 is added');
});

test('a basket emptied by causes is not relaunched from its stale snapshot; a cancelled change is never "upcoming"', async () => {
  const { retireIndexRules, indexBasketView } = await import('./index-membership.ts');
  // no prices for 3 weeks: every member and reserve is stale → the basket empties
  await runIndexRules(db, D('2026-12-28T06:00:00Z'));
  assert.equal(await count(), 0);
  const launches = async () => (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM index_members WHERE basket = 'pokemon:top-100' AND join_reason = 'launch'`)).rows[0].n;
  const l0 = await launches();
  await runIndexRules(db, D('2026-12-28T12:00:00Z'));
  await runIndexRules(db, D('2026-12-28T18:00:00Z'));
  assert.equal(await launches(), l0, 'no relaunch loop');
  // a pending change cancelled by a switch-off is not shown as upcoming, and the basket is not "governed"
  await db.query(
    `INSERT INTO index_changes(basket, change_date, reference_at, published_at, effective_at, adds, removes, reserves)
     VALUES('pokemon:top-100', '2027-01-01', '2027-01-01', '2027-01-01T06:00:00Z', '2027-01-04T06:00:00Z', $1, '[]', '{}')`,
    [[ids.get(7)]],
  );
  await retireIndexRules(db, D('2027-01-02T00:00:00Z'));
  const v = await indexBasketView(db, 'INDEX:top-100');
  assert.equal(v?.upcoming, null);
  assert.equal(v?.governed, false);
});
