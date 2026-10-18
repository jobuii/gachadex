import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// Index rules v3 in the live pass (2026-10-18 plan Q-A6/Q-A7/Q-A8): turning INDEX_RULES_V3 on mid-stream launches the
// member lists from the live baskets with no jump in the level, a member delisted later leaves for that cause, and
// the history rebuild reproduces every live pass — before AND after the switch.
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
const oc = (id: string, usd: number) => ({
  game: 'pokemon', symbol: `pokemon:${id}`, cardId: id, displayName: `${id} #1`, variant: null, imageSmall: null,
  rawE6: BigInt(Math.round(usd * 1e6)), observedAt: new Date(), featured: true, productType: 'single' as const,
});
const levels = async () =>
  (
    await db.query<{ v: string }>(
      `SELECT o.index_price_e6::text AS v FROM oracle_prices o JOIN markets m ON m.id = o.market_id WHERE m.symbol = 'INDEX:top-100' ORDER BY o.ingested_at, o.id`,
    )
  ).rows.map((r) => BigInt(r.v));

test('switch on: launch without a jump, a delisted member leaves, and the rebuild matches live pass for pass', async () => {
  const cfg = config as { indexRulesV3: boolean };
  await ingest(db, async () => [oc('a', 100), oc('b', 50), oc('c', 10)]);
  await ingest(db, async () => [oc('a', 110), oc('b', 50), oc('c', 10)]);
  cfg.indexRulesV3 = true;
  try {
    await ingest(db, async () => [oc('a', 121), oc('b', 50), oc('c', 10)]); // launch pass
    const launched = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM index_members WHERE basket = 'pokemon:top-100' AND left_at IS NULL`);
    assert.equal(launched.rows[0].n, 3, 'the member list starts as the live basket');
    const [, l2, l3] = await levels();
    // GJ = Σ-price ratio of the previous basket: (121+50+10)/(110+50+10) — exactly the price move, no membership jump.
    assert.equal(l3, BigInt(Math.round(Number(l2) * (181 / 170))));

    await db.query(`UPDATE markets SET status = 'delisted' WHERE symbol = 'pokemon:c'`);
    await ingest(db, async () => [oc('a', 121), oc('b', 55)]); // c is no longer fetched
    const c = await db.query<{ leave_reason: string }>(
      `SELECT im.leave_reason FROM index_members im JOIN markets m ON m.id = im.market_id WHERE m.symbol = 'pokemon:c'`,
    );
    assert.equal(c.rows[0].leave_reason, 'delisted');

    const live = (await levels()).map(String);
    const rebuilt = (await planIndexRebuild(db, OPTS)).find((s) => s.symbol === 'INDEX:top-100')!.points.map((p) => p.value.toString());
    assert.deepEqual(rebuilt, live, 'the rebuild reproduces old-rule passes and v3 passes alike');
  } finally {
    cfg.indexRulesV3 = false;
  }
});
