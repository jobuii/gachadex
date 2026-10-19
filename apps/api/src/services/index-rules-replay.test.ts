import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// The Q-A4 replay (index-rules-replay.ts) on two months of backdated passes: when the rules never bind it reproduces
// the old rule exactly; a card that goes quiet leaves for 'stale' after 14 days (the old rule drops it at once) and
// comes back only at a later change date; changes are published on the 1st and applied on/after the 4th.
process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { config } = await import('../config.ts');
const { upsertCardMarket, upsertIndexMarket } = await import('./markets.ts');
const { BASE_AT } = await import('./featured-history.ts');
const { replayOld, replayV3, compareReplays, backfillGradedHistory } = await import('./index-rules-replay.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

const OPTS = { freshMs: config.indexFreshMs, outlierFactor: config.indexOutlierFactor, gradedConstituents: 100, sealedMin: 5, sealedEnabled: false, gapFill: false };
const DAY = 86_400_000;
const START = Date.parse('2026-06-10T12:00:00Z');
const DAYS = 62; // → 10 Aug: change dates 1 Jul and 1 Aug
const OUTAGE: [Date, Date] = [new Date('2026-09-24T00:00:00Z'), new Date('2026-10-02T00:00:00Z')];

async function history(quiet: { card: string; from: number; to: number } | null) {
  await db.query(`DELETE FROM oracle_prices`);
  // a second game whose cards are first priced 3 days later: its basket must launch then, not at the first pass
  const late = new Map<string, string>();
  for (const c of ['x', 'y']) {
    late.set(c, await upsertCardMarket(db, { game: 'onepiece', symbol: `onepiece:rp-${c}`, cardId: `rp-op-${c}`, displayName: `${c} #2`, variant: 'Foil', imageSmall: null, featured: true, productType: 'single', tcgplayerId: c === 'x' ? 801 : 802 }));
  }
  const opIndex = await db.tx((q) => upsertIndexMarket(q, { game: 'onepiece', slug: 'top-100', name: 'OP Top 100', tradeable: true }));
  const cards = 'abcdefghij'.split('');
  const ids = new Map<string, string>();
  for (const [i, c] of cards.entries()) {
    ids.set(c, await upsertCardMarket(db, { game: 'pokemon', symbol: `pokemon:rp-${c}`, cardId: `rp-${c}`, displayName: `${c} #1`, variant: 'Holofoil', imageSmall: null, featured: true, productType: 'single', tcgplayerId: 700 + i }));
  }
  await db.query(`DELETE FROM featured_events`);
  for (const id of [...ids.values(), ...late.values()]) await db.query(`INSERT INTO featured_events(market_id, featured, at, source) VALUES($1, true, $2, 'seed:test')`, [id, BASE_AT]);
  const index = await db.tx((q) => upsertIndexMarket(q, { game: 'pokemon', slug: 'top-100', name: 'Top 100', tradeable: true }));
  for (let d = 0; d < DAYS; d++) {
    const t = new Date(START + d * DAY);
    for (const [i, c] of cards.entries()) {
      if (quiet && c === quiet.card && d >= quiet.from && d < quiet.to) continue;
      const usd = (i + 1) * 10 * (1 + 0.01 * Math.sin(d + i)); // gentle moves, never an outlier
      await db.query(`INSERT INTO oracle_prices(market_id, index_price_e6, raw_payload, source_observed_at, ingested_at) VALUES($1, $2, '{}', $3, $3)`,
        [ids.get(c), BigInt(Math.round(usd * 1e6)).toString(), new Date(t.getTime() + 60_000)]);
    }
    // live timing: the pass is stamped t; its card prints land after t, its index prints after them (the pass cutoff)
    await db.query(`INSERT INTO oracle_prices(market_id, index_price_e6, raw_payload, source_observed_at, ingested_at) VALUES($1, 1000000000, '{}', $2, $3)`, [index, t, new Date(t.getTime() + 120_000)]);
    if (d >= 3) {
      for (const [i, id] of [...late.values()].entries()) {
        await db.query(`INSERT INTO oracle_prices(market_id, index_price_e6, raw_payload, source_observed_at, ingested_at) VALUES($1, $2, '{}', $3, $3)`, [id, (50 + i) * 1_000_000, new Date(t.getTime() + 60_000)]);
      }
      await db.query(`INSERT INTO oracle_prices(market_id, index_price_e6, raw_payload, source_observed_at, ingested_at) VALUES($1, 1000000000, '{}', $2, $3)`, [opIndex, t, new Date(t.getTime() + 120_000)]);
    }
  }
  return ids;
}
const series = (r: { series: { symbol: string; points: { value: bigint }[] }[] }) => r.series.find((s) => s.symbol === 'INDEX:top-100')!.points.map((p) => p.value);

test('rules that never bind: the v3 replay equals the old rule pass for pass; changes publish on the 1st, apply on the 4th', async () => {
  await history(null);
  const old = await replayOld(db, OPTS);
  const v3 = await replayV3(db, OPTS, old, 110);
  assert.deepEqual(series(v3), series(old));
  const top = v3.changes.filter((c) => c.basket === 'pokemon:top-100');
  assert.deepEqual(top.map((c) => c.changeDate), ['2026-07-01', '2026-08-01']);
  for (const c of top) assert.ok(c.appliedAt && c.appliedAt >= `${c.changeDate.slice(0, 8)}04`, `${c.changeDate} applied on/after the 4th`);
  const cmp = compareReplays(old, v3, OUTAGE).find((c) => c.symbol === 'INDEX:top-100')!;
  assert.equal(cmp.maxDiffPct, 0);
  assert.equal(cmp.points, DAYS);
  const op = await db.query<{ n: number; instant: number }>(
    `SELECT count(*)::int AS n, count(*) FILTER (WHERE left_at = joined_at)::int AS instant FROM index_members WHERE basket = 'onepiece:top-100' AND join_reason = 'launch'`,
  );
  assert.deepEqual(op.rows[0], { n: 2, instant: 0 }, 'the later game launches at its own first pass, with prices');
});

test('a card quiet for three weeks: the old rule drops it at once, v3 keeps it flat for 14 days, then out for "stale" until a change date', async () => {
  await history({ card: 'j', from: 22, to: 43 }); // no price 2 Jul → 22 Jul
  const old = await replayOld(db, OPTS);
  const v3 = await replayV3(db, OPTS, old, 110);
  const july = v3.changes.find((c) => c.basket === 'pokemon:top-100' && c.changeDate === '2026-08-01');
  assert.equal(july?.joined, 1, 'j re-joins at the August change');
  const stale = await db.query<{ left_at: Date }>(
    `SELECT im.left_at FROM index_members im JOIN markets m ON m.id = im.market_id WHERE m.symbol = 'pokemon:rp-j' AND im.leave_reason = 'stale'`,
  );
  assert.equal(stale.rows.length, 1, 'removed for the cause, once');
  const days = (stale.rows[0].left_at.getTime() - (START + 21 * DAY + 60_000)) / DAY; // from its last price (day 21)
  assert.ok(days >= 14 && days < 16, `left ${days.toFixed(1)} days after its last price`);
  assert.notDeepEqual(series(v3), series(old), 'the rules bind, so the levels differ');
});

test('PSA-10 history before tracking began is written from each print, one row per change, and stops where tracking starts', async () => {
  const id = await upsertCardMarket(db, { game: 'pokemon', symbol: 'pokemon:gh', cardId: 'gh', displayName: 'gh #1', variant: 'Holofoil', imageSmall: null });
  const at = (d: number) => new Date(START + d * DAY);
  for (const [d, g] of [[0, 100], [1, 100], [2, 200], [3, null], [5, 300]] as const) {
    await db.query(`INSERT INTO oracle_prices(market_id, index_price_e6, raw_payload, source_observed_at, ingested_at) VALUES($1, 1000000, $2, $3, $3)`,
      [id, JSON.stringify(g == null ? {} : { gradedE6: String(g) }), at(d)]);
  }
  await db.query(`DELETE FROM graded_prints`);
  await db.query(`INSERT INTO graded_prints(market_id, graded_e6, observed_at) VALUES($1, 999, $2)`, [id, at(4)]); // tracking began on day 4
  await backfillGradedHistory(db);
  const rows = (await db.query<{ g: string | null; at: Date }>(`SELECT graded_e6::text AS g, observed_at AS at FROM graded_prints WHERE market_id = $1 ORDER BY observed_at`, [id])).rows;
  assert.deepEqual(rows.map((r) => r.g), ['100', '200', null, '999'], 'changes only (100, 200, none), then the tracked row — day 5 is tracking\'s own');
});
