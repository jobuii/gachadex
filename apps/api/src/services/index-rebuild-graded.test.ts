import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// A PSA-10-only move (raw price unchanged → no card print) must still reach the Graded index history: the rebuild
// replays graded_prints, so it reproduces the live Graded level pass for pass (2026-10-17: without it, the first live
// pass after a rebuild jumped Pokémon Graded +6.5%).
process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { config } = await import('../config.ts');
const { ingest } = await import('./oracle.ts');
const { planIndexRebuild } = await import('./index-rebuild.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

const OPTS = { freshMs: config.indexFreshMs, outlierFactor: config.indexOutlierFactor, gradedConstituents: 100, sealedMin: 5, sealedEnabled: false, gapFill: false };
const T0 = new Date(Date.now() - 3_600_000); // one provider snapshot: every pass below re-serves it (raw unchanged)
const oc = (id: string, usd: number, psa10: number) => ({
  game: 'pokemon', symbol: `pokemon:${id}`, cardId: id, displayName: `${id} #1`, variant: null, imageSmall: null,
  rawE6: BigInt(usd * 1e6), gradedE6: BigInt(psa10 * 1e6), observedAt: T0, featured: true, productType: 'single' as const,
});
const count = async (sql: string) => (await db.query<{ n: number }>(sql)).rows[0].n;

test('PSA-10-only moves are recorded (on change only) and the rebuilt Graded index matches the live one', async () => {
  await ingest(db, async () => [oc('a', 100, 1000), oc('b', 50, 500)]);
  await ingest(db, async () => [oc('a', 100, 1500), oc('b', 50, 500)]); // a's PSA-10 moves, raw doesn't
  await ingest(db, async () => [oc('a', 100, 1500), oc('b', 50, 400)]);
  await ingest(db, async () => [oc('a', 100, 1500), oc('b', 50, 400)]); // nothing moves

  assert.equal(await count(`SELECT count(*)::int AS n FROM oracle_prices o JOIN markets m ON m.id = o.market_id WHERE m.kind = 'card'`), 2, 'no extra raw print: freshness / the stale halt are untouched');
  assert.equal(await count(`SELECT count(*)::int AS n FROM graded_prints`), 4, 'a, b at first sight + one row per PSA-10 change');

  const live = (
    await db.query<{ v: string }>(
      `SELECT o.index_price_e6::text AS v FROM oracle_prices o JOIN markets m ON m.id = o.market_id WHERE m.symbol = 'INDEX:graded' ORDER BY o.ingested_at`,
    )
  ).rows.map((r) => Number(r.v) / 1e6);
  assert.ok(live[1] > live[0] && live[2] < live[1], `the live Graded index moved on the PSA-10-only passes: ${live}`);
  const rebuilt = (await planIndexRebuild(db, OPTS)).find((s) => s.symbol === 'INDEX:graded')!.points.map((p) => Number(p.value) / 1e6);
  assert.deepEqual(rebuilt, live, 'the rebuild reproduces it pass for pass — no seam at the next live pass');
});
