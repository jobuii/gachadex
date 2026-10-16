import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { upsertCardMarket } = await import('./markets.ts');
const { dayWindows, scrydexDayPrice, tcgplDayPrice, planBackfill, applyBackfill, serializeBackfillPlan, parseBackfillPlan } = await import('./price-backfill.ts');
const { revertHistoryRepair } = await import('./history-repair.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

test('dayWindows groups contiguous gap days (one history call per window)', () => {
  assert.deepEqual(dayWindows(['2026-09-26', '2026-09-24', '2026-09-25', '2026-08-30', '2026-06-25']), [
    ['2026-06-25', '2026-06-25'], ['2026-08-30', '2026-08-30'], ['2026-09-24', '2026-09-26'],
  ]);
});

test('scrydexDayPrice: the LIVE extractRaw / graded ladder on our variant — JPY via FX; a broken best grade → no price', () => {
  const day = { date: '2026-09-25', prices: [
    { variant: 'normal', type: 'raw', condition: 'NM', market: 19, currency: 'USD' },
    { variant: 'foil', type: 'raw', condition: 'NM', market: 1450, low: 1300, currency: 'USD' },
    { variant: 'foil', type: 'graded', company: 'PSA', grade: '10', market: 5000, currency: 'USD' },
  ] };
  assert.deepEqual(scrydexDayPrice(day, 2831, 'foil', null), { raw: 1450, psa10: 5000 }, 'our (foil) variant, never the normal printing');
  // The best grade is a $1 placeholder: live would have priced tcgpl's same-grade market, which the backfill doesn't
  // have for this card — so no price, not the downgraded LP rung.
  const broken = { date: 'd', prices: [
    { variant: 'foil', type: 'raw', condition: 'NM', market: 1, currency: 'USD' },
    { variant: 'foil', type: 'raw', condition: 'LP', market: 1400, low: 1300, currency: 'USD' },
  ] };
  assert.equal(scrydexDayPrice(broken, 2831, 'foil', null).raw, null);
  const jp = { date: 'd', prices: [{ variant: 'holofoil', type: 'raw', condition: 'NM', market: 10000, currency: 'JPY' }] };
  assert.equal(scrydexDayPrice(jp, 7, 'holofoil', 0.0063).raw, 63);
  assert.equal(scrydexDayPrice(jp, 7, 'holofoil', null).raw, null, 'no FX → no price');
  assert.equal(scrydexDayPrice(day, 2831, null, null).raw, null, 'no resolved variant → nothing guessed');
});

test('tcgplDayPrice: latest TCGplayer point ≤6 days before, NM→LP, skips a placeholder rung', () => {
  const pts = [
    { date: '2026-09-21', prices: [{ source: 'tcgplayer', condition: 'near_mint', price_market: 0.99 }, { source: 'tcgplayer', condition: 'lightly_played', price_market: 990 },
      { source: 'ebay', grader: 'psa', grade: '10', avg_7d: 2500 }] },
    { date: '2026-09-01', prices: [{ source: 'tcgplayer', condition: 'near_mint', price_market: 800 }] },
  ] as any;
  assert.deepEqual(tcgplDayPrice(pts, '2026-09-25'), { raw: 990, psa10: 2500, date: '2026-09-21' });
  assert.equal(tcgplDayPrice(pts, '2026-09-15').raw, null, 'nothing within 6 days → no invented price');
});

test('plan + apply: Scrydex cards use price_history, others tcgpl; prints + marks land at 06:00 UTC; revert is exact', async () => {
  const sxM = await upsertCardMarket(db, { game: 'mtg', symbol: 'mtg:birds', cardId: 'birds', displayName: 'Birds #231', variant: 'Foil', imageSmall: null, tcgplayerId: 2831, featured: true, scrydexCardId: 'sx-birds' });
  const tpM = await upsertCardMarket(db, { game: 'mtg', symbol: 'mtg:mox', cardId: 'mox', displayName: 'Mox #1', variant: null, imageSmall: null, providerCardId: 'tpl-mox', featured: true });
  const calls: string[] = [];
  const deps = {
    scrydexCards: async () => [{ id: 'sx-birds', variants: [
      { name: 'normal', marketplaces: [{ product_id: '2831' }], prices: [{ type: 'raw', condition: 'NM', market: 19 }] },
      { name: 'foil', marketplaces: [{ product_id: '2831' }], prices: [{ type: 'raw', condition: 'NM', market: 1500 }] },
    ] } as any],
    scrydexHistory: async (_s: string, id: string, a: string, b: string) => {
      calls.push(`sx ${id} ${a}..${b}`);
      return [{ date: '2026-09-25', prices: [{ variant: 'normal', type: 'raw', condition: 'NM', market: 20 }, { variant: 'foil', type: 'raw', condition: 'NM', market: 1450 }] }];
    },
    tcgplHistory: async (id: string) => {
      calls.push(`tpl ${id}`);
      return [{ date: '2026-09-24', prices: [{ source: 'tcgplayer', condition: 'near_mint', price_market: 3000 }] }] as any;
    },
    fxJpyUsd: async () => null,
  };
  // Both markets traded after the gap (a later mark) — so a backfilled mark can't become their live mark.
  await db.query(`INSERT INTO marks(market_id, mark_price_e6, index_price_e6, computed_at) VALUES ($1, 1, 1, '2026-10-05'), ($2, 1, 1, '2026-10-05')`, [sxM, tpM]);
  const plan = await planBackfill(db, deps, ['2026-09-25']);
  assert.deepEqual(calls, ['sx sx-birds 2026-09-25..2026-09-25', 'tpl tpl-mox']);
  const row = (m: string) => plan.rows.find((r) => r.marketId === m)!;
  assert.equal(row(sxM).priceE6, 1_450_000_000n, 'the FOIL history row, never the normal printing');
  assert.equal(row(tpM).priceE6, 3_000_000_000n);

  const saved = parseBackfillPlan(serializeBackfillPlan(plan));
  assert.deepEqual(saved, plan, 'a saved plan round-trips exactly (bigints included)');
  const r = await applyBackfill(db, saved); // --apply --plan: the reviewed rows, no second provider fetch
  assert.equal(r.points, 2);
  const at = await db.query<{ t: string }>(`SELECT ingested_at::text AS t FROM oracle_prices WHERE market_id = $1`, [sxM]);
  assert.ok(at.rows[0].t.startsWith('2026-09-25 06:00:00'));
  assert.equal((await applyBackfill(db, plan)).points, 0, 'idempotent');
  await revertHistoryRepair(db, r.runId);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM oracle_prices`)).rows[0].n, 0);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM marks`)).rows[0].n, 2, 'only the two pre-existing later marks remain');
});

test('a market with NO mark after the gap day is not backfilled — the backfilled mark would become its live mark (review R6)', async () => {
  const m = await upsertCardMarket(db, { game: 'mtg', symbol: 'mtg:frozen', cardId: 'frozen', displayName: 'Frozen #1', variant: null, imageSmall: null, providerCardId: 'tpl-frozen', featured: true });
  await db.query(`INSERT INTO marks(market_id, mark_price_e6, index_price_e6, computed_at) VALUES ($1, 1, 1, '2026-09-01')`, [m]);
  const plan = await planBackfill(db, {
    scrydexCards: async () => [], scrydexHistory: async () => [], fxJpyUsd: async () => null,
    tcgplHistory: async () => [{ date: '2026-09-24', prices: [{ source: 'tcgplayer', condition: 'near_mint', price_market: 3000 }] }] as any,
  }, ['2026-09-25']);
  assert.equal(plan.rows.filter((r) => r.marketId === m).length, 0);
  assert.ok(plan.misses.some((x) => x.symbol === 'mtg:frozen' && /would become the live mark/.test(x.reason)));
});

test('a saved plan never writes over a market pinned since it was made', async () => {
  const m = await upsertCardMarket(db, { game: 'mtg', symbol: 'mtg:pinned-later', cardId: 'pinned-later', displayName: 'P #1', variant: null, imageSmall: null, providerCardId: 'tpl-p', featured: true });
  await db.query(`INSERT INTO marks(market_id, mark_price_e6, index_price_e6, computed_at) VALUES ($1, 1, 1, '2026-10-05')`, [m]);
  const plan = await planBackfill(db, {
    scrydexCards: async () => [],
    scrydexHistory: async () => [],
    tcgplHistory: async () => [{ date: '2026-09-24', prices: [{ source: 'tcgplayer', condition: 'near_mint', price_market: 50 }] }] as any,
    fxJpyUsd: async () => null,
  }, ['2026-09-25']);
  assert.equal(plan.rows.filter((r) => r.marketId === m).length, 1);
  await db.query(`UPDATE markets SET price_pinned = true WHERE id = $1`, [m]);
  await applyBackfill(db, plan);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM oracle_prices WHERE market_id = $1`, [m])).rows[0].n, 0);
});
