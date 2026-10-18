import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// The history rebuild must reproduce what the LIVE ingest computes, pass for pass — then apply/revert must be
// exact. Hermetic DB; passes are driven through the real `ingest`.
process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { config } = await import('../config.ts');
const { ingest } = await import('./oracle.ts');
const { planIndexRebuild, applyIndexRebuild } = await import('./index-rebuild.ts');
const { revertHistoryRepair, withIngestLease } = await import('./history-repair.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

const OPTS = { freshMs: config.indexFreshMs, outlierFactor: config.indexOutlierFactor, gradedConstituents: 100, sealedMin: 5, sealedEnabled: false, gapFill: true };
const oc = (id: string, usd: number) => ({
  game: 'mtg', symbol: `mtg:${id}`, cardId: id, displayName: `${id} #1`, variant: null, imageSmall: null,
  rawE6: BigInt(Math.round(usd * 1e6)), featured: true, productType: 'single' as const,
});
const series = async (symbol: string) =>
  (
    await db.query<{ id: string; v: string }>(
      `SELECT o.id::text AS id, o.index_price_e6::text AS v FROM oracle_prices o JOIN markets m ON m.id = o.market_id
        WHERE m.symbol = $1 ORDER BY o.source_observed_at`,
      [symbol],
    )
  ).rows;
const SYMS = ['INDEX:mtg:top-100', 'INDEX:mtg:gp-top-100', 'INDEX:mtg:pdq-top-100'];

test('the plan reproduces the live ingest pass for pass (GJ / G&P / Pokedaq)', async () => {
  await ingest(db, async () => [oc('a', 100), oc('b', 50), oc('c', 10)]);
  await ingest(db, async () => [oc('a', 110), oc('b', 45), oc('c', 10)]);
  await ingest(db, async () => [oc('a', 120), oc('b', 30), oc('c', 1000)]); // c ×100 → the outlier guard
  const plan = await planIndexRebuild(db, OPTS);
  for (const sym of SYMS) {
    const live = (await series(sym)).map((r) => r.v);
    const s = plan.find((x) => x.symbol === sym)!;
    assert.deepEqual(s.points.map((p) => p.value.toString()), live, sym);
    assert.ok(s.points.every((p) => p.oraclePriceId), `${sym}: every point maps onto an existing print`);
  }
});

test('apply rewrites a corrupted history back to the methodology, rescales marks; revert is exact', async () => {
  const before = await series('INDEX:mtg:gp-top-100');
  // Corrupt it the way the old arithmetic chain did (drifted up 50%), marks included.
  await db.query(
    `UPDATE oracle_prices SET index_price_e6 = index_price_e6 * 3 / 2
      WHERE market_id = (SELECT id FROM markets WHERE symbol = 'INDEX:mtg:gp-top-100')`,
  );
  await db.query(
    `UPDATE marks SET mark_price_e6 = mark_price_e6 * 3 / 2, index_price_e6 = index_price_e6 * 3 / 2
      WHERE market_id = (SELECT id FROM markets WHERE symbol = 'INDEX:mtg:gp-top-100')`,
  );
  const corrupted = await series('INDEX:mtg:gp-top-100');
  const payloads = async () =>
    (await db.query<{ p: unknown }>(`SELECT raw_payload AS p FROM oracle_prices WHERE market_id = (SELECT id FROM markets WHERE symbol = 'INDEX:mtg:gp-top-100') ORDER BY id`)).rows;
  const payloadsBefore = await payloads();

  const rep = await withIngestLease(db, async () => applyIndexRebuild(db, await planIndexRebuild(db, OPTS)));
  assert.deepEqual((await series('INDEX:mtg:gp-top-100')).map((r) => r.v), before.map((r) => r.v), 'restored to the live values');
  const mk = await db.query<{ m: string; i: string }>(
    `SELECT mark_price_e6::text AS m, index_price_e6::text AS i FROM marks
      WHERE market_id = (SELECT id FROM markets WHERE symbol = 'INDEX:mtg:gp-top-100') ORDER BY computed_at DESC LIMIT 1`,
  );
  assert.equal(mk.rows[0].i, before[before.length - 1].v, 'the latest mark carries the rebuilt index');
  assert.equal(mk.rows[0].m, mk.rows[0].i, 'no skew → mark == index');
  assert.ok(rep.printsUpdated > 0 && rep.marksRescaled > 0);

  const rv = await revertHistoryRepair(db, rep.runId);
  assert.ok(rv.restored > 0);
  assert.deepEqual((await series('INDEX:mtg:gp-top-100')).map((r) => r.v), corrupted.map((r) => r.v), 'revert restores exactly');
  assert.deepEqual(await payloads(), payloadsBefore, '…payloads included (no leftover rebuild keys)');
});

test('a day with no pass gets a point ONLY when fresh card data exists for it — never invented past the fresh window', async () => {
  // Shift the three passes 6 days back: the days between them and today have no pass.
  await db.query(`UPDATE oracle_prices SET source_observed_at = source_observed_at - interval '6 days', ingested_at = ingested_at - interval '6 days'`);
  await db.query(`UPDATE featured_events SET at = at - interval '6 days'`); // the cards were featured when those passes ran
  const lastReal = (await db.query<{ t: Date }>(`SELECT max(ingested_at) AS t FROM oracle_prices`)).rows[0].t.getTime();
  await ingest(db, async () => [oc('a', 120), oc('b', 30), oc('c', 1000)]); // today's pass
  const stalePoints = (plan: Awaited<ReturnType<typeof planIndexRebuild>>) =>
    plan.find((x) => x.symbol === 'INDEX:mtg:top-100')!.points.filter((p) => !p.oraclePriceId && p.t.getTime() > lastReal + OPTS.freshMs).length;
  assert.equal(stalePoints(await planIndexRebuild(db, OPTS)), 0, 'past the fresh window with no data → nothing invented');

  // A backfilled print for every card 3 days ago (as the provider-history backfill writes them).
  const day = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
  await db.query(
    `INSERT INTO oracle_prices(market_id, index_price_e6, raw_payload, source_observed_at, ingested_at, is_accepted)
     SELECT id, 105000000, '{"backfill":true}', ($1 || 'T06:00:00Z')::timestamptz, ($1 || 'T06:00:00Z')::timestamptz, true
       FROM markets WHERE symbol IN ('mtg:a', 'mtg:b', 'mtg:c')`,
    [day],
  );
  const plan = await planIndexRebuild(db, OPTS);
  const top = plan.find((x) => x.symbol === 'INDEX:mtg:top-100')!;
  assert.ok(top.points.some((p) => !p.oraclePriceId && p.t.toISOString().startsWith(day)), 'the backfilled day now carries a real point');
});
