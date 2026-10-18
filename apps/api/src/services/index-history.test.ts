import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// Point-in-time index history (2026-10-18 plan P2): every featured/status flip is logged by a trigger, a price pass
// can no longer overwrite discovery's featured flag, each index pass logs its basket, and the history rebuild reads
// featured/status AS OF each pass — so a card de-featured or delisted later still counts while it was a member.
process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { config } = await import('../config.ts');
const { ingest } = await import('./oracle.ts');
const { withFeaturedSource } = await import('./markets.ts');
const { planIndexRebuild } = await import('./index-rebuild.ts');
const { planFeaturedSeed, applyFeaturedSeed, BASE_AT } = await import('./featured-history.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

const OPTS = { freshMs: config.indexFreshMs, outlierFactor: config.indexOutlierFactor, gradedConstituents: 100, sealedMin: 5, sealedEnabled: false, gapFill: false };
const oc = (id: string, usd: number, featured = true) => ({
  game: 'pokemon', symbol: `pokemon:${id}`, cardId: id, displayName: `${id} #1`, variant: null, imageSmall: null,
  rawE6: BigInt(Math.round(usd * 1e6)), observedAt: new Date(), featured, productType: 'single' as const,
});
const events = async (symbol: string) =>
  (
    await db.query<{ featured: boolean; source: string }>(
      `SELECT e.featured, e.source FROM featured_events e JOIN markets m ON m.id = e.market_id WHERE m.symbol = $1 ORDER BY e.id`,
      [symbol],
    )
  ).rows;

test('the trigger logs every featured flip once, with the writer\'s source; unchanged writes log nothing', async () => {
  await ingest(db, async () => [oc('t1', 20)]); // legacy pokemontcg feed (test env) stamps featured on insert
  assert.deepEqual(await events('pokemon:t1'), [{ featured: true, source: 'unknown' }]);
  await ingest(db, async () => [oc('t1', 21)]); // same flag again → no event
  assert.equal((await events('pokemon:t1')).length, 1);
  await withFeaturedSource(db, 'discovery', (q) => q.query(`UPDATE markets SET featured = false WHERE symbol = 'pokemon:t1'`));
  assert.deepEqual((await events('pokemon:t1'))[1], { featured: false, source: 'discovery' });
  await db.query(`UPDATE markets SET status = 'delisted' WHERE symbol = 'pokemon:t1'`);
  const st = await db.query<{ status: string }>(
    `SELECT s.status FROM market_status_events s JOIN markets m ON m.id = s.market_id WHERE m.symbol = 'pokemon:t1'`,
  );
  assert.deepEqual(st.rows.map((r) => r.status), ['delisted']);
});

test('a Scrydex/tcgpl price pass never writes back the featured flag it read at the start of the pass', async () => {
  const cfg = config as { oraclePrimary: string };
  const was = cfg.oraclePrimary;
  cfg.oraclePrimary = 'scrydex';
  try {
    await ingest(db, async () => [oc('e1', 30)]); // new market: inserted not featured (no echo to write)
    await withFeaturedSource(db, 'discovery', (q) => q.query(`UPDATE markets SET featured = true WHERE symbol = 'pokemon:e1'`));
    // a pass that READ featured=false before discovery's flip lands after it — it must not undo the flip
    await ingest(db, async () => [oc('e1', 31, false)]);
    const r = await db.query<{ featured: boolean }>(`SELECT featured FROM markets WHERE symbol = 'pokemon:e1'`);
    assert.equal(r.rows[0].featured, true);
  } finally {
    cfg.oraclePrimary = was;
  }
});

test('each index pass logs its basket, missing and outlier cards; the rebuild replays flips and delistings as live did', async () => {
  await db.query(`UPDATE markets SET featured = false WHERE kind = 'card'`); // isolate from the tests above
  await ingest(db, async () => [oc('a', 100), oc('b', 50), oc('c', 10)]);
  // between passes: discovery drops c, the retirement sweep delists b (live stops fetching it)
  await withFeaturedSource(db, 'discovery', (q) => q.query(`UPDATE markets SET featured = false WHERE symbol = 'pokemon:c'`));
  await db.query(`UPDATE markets SET status = 'delisted' WHERE symbol = 'pokemon:b'`);
  await ingest(db, async () => [oc('a', 110), oc('c', 12, false)]);
  await ingest(db, async () => [oc('a', 121), oc('c', 13, false)]);

  const log = await db.query<{ members: string[]; missing: string[] }>(
    `SELECT l.members, l.missing FROM index_pass_log l JOIN markets m ON m.id = l.market_id
      WHERE m.symbol = 'INDEX:top-100' ORDER BY l.pass_at, l.id`,
  );
  const last3 = log.rows.slice(-3);
  assert.deepEqual(last3[0].members.slice().sort(), ['a', 'b', 'c']);
  assert.deepEqual(last3[1].members, ['a'], 'c de-featured, b delisted → a alone');
  assert.deepEqual(last3[1].missing, ['b'], 'b was in the previous basket but live had no price for it');

  const live = (
    await db.query<{ v: string }>(
      `SELECT o.index_price_e6::text AS v FROM oracle_prices o JOIN markets m ON m.id = o.market_id
        WHERE m.symbol = 'INDEX:top-100' ORDER BY o.ingested_at`,
    )
  ).rows.map((r) => r.v);
  const rebuilt = (await planIndexRebuild(db, OPTS)).find((s) => s.symbol === 'INDEX:top-100')!.points.map((p) => p.value.toString());
  assert.deepEqual(rebuilt.slice(-3), live.slice(-3), 'the rebuild reproduces the live passes, flips and delisting included');
});

test('seed: base list + snapshot diffs dated per game, reconciled against the live flags; a second seed refuses', async () => {
  await ingest(db, async () => [oc('s1', 40), oc('s2', 41), oc('s3', 42)]);
  const id = async (sym: string) => (await db.query<{ id: string }>(`SELECT id FROM markets WHERE symbol = $1`, [sym])).rows[0].id;
  const [s1, s2, s3] = [await id('pokemon:s1'), await id('pokemon:s2'), await id('pokemon:s3')];
  await db.query(`DELETE FROM featured_events WHERE market_id = ANY($1)`, [[s1, s2, s3]]); // pretend they predate the trigger
  await db.query(`UPDATE markets SET featured = (id = $1 OR id = $2) WHERE id = ANY($3)`, [s2, s3, [s1, s2, s3]]); // as of the snapshot
  await db.query(`DELETE FROM featured_events WHERE market_id = ANY($1)`, [[s1, s2, s3]]);
  // after the snapshot (trigger live): s3 dropped — a recorded event; then s2 dropped by SQL nobody logged → reconcile
  await withFeaturedSource(db, 'discovery', (q) => q.query(`UPDATE markets SET featured = false WHERE id = $1`, [s3]));
  await db.query(`ALTER TABLE markets DISABLE TRIGGER trg_market_flag_changes`);
  await db.query(`UPDATE markets SET featured = false WHERE id = $1`, [s2]);
  await db.query(`ALTER TABLE markets ENABLE TRIGGER trg_market_flag_changes`);

  const run = new Date('2026-10-17T08:35:42Z');
  const plan = await planFeaturedSeed(db, [
    { label: 'base', at: BASE_AT, marketIds: new Set([s1, s2]) },
    { label: 'snap', at: new Date('2026-10-18T16:31:23Z'), marketIds: new Set([s2, s3]), changesAt: { pokemon: run } },
  ], new Date());
  const mine = plan.events.filter((e) => [s1, s2, s3].includes(e.marketId)).map((e) => [e.marketId, e.featured, e.at.toISOString()]);
  assert.deepEqual(mine.sort(), [
    [s1, true, BASE_AT.toISOString()], [s1, false, run.toISOString()],
    [s2, true, BASE_AT.toISOString()],
    [s3, true, run.toISOString()],
  ].sort());
  assert.deepEqual(plan.reconcile.filter((e) => [s1, s2, s3].includes(e.marketId)).map((e) => [e.marketId, e.featured]), [[s2, false]], 'only the unlogged drop needs a reconcile event');
  await applyFeaturedSeed(db, plan);
  await assert.rejects(applyFeaturedSeed(db, plan), /already holds/);
  assert.ok((await applyFeaturedSeed(db, plan, { replace: true })) > 0);
});
