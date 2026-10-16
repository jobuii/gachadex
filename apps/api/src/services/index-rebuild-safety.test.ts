import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// Safety properties of the history rebuild against LIVE data (2026-10 adversarial review: R1, R2, R4, R5).
process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { config } = await import('../config.ts');
const { ingest } = await import('./oracle.ts');
const { setManualPrice } = await import('./admin-pricing.ts');
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
const marketId = async (symbol: string) => (await db.query<{ id: string }>(`SELECT id FROM markets WHERE symbol = $1`, [symbol])).rows[0].id;
const values = (plan: Awaited<ReturnType<typeof planIndexRebuild>>) =>
  Object.fromEntries(plan.map((s) => [s.symbol, s.points.map((p) => `${p.t.toISOString()}=${p.value}`)]));
const apply = (opts = {}) => withIngestLease(db, async () => applyIndexRebuild(db, await planIndexRebuild(db, OPTS), () => {}, opts));

test('R2: a second rebuild run is idempotent even after the first inserted a point at a real pass', async () => {
  await ingest(db, async () => [oc('a', 100), oc('b', 50)]);
  await ingest(db, async () => [oc('a', 150), oc('b', 50)]);
  await ingest(db, async () => [oc('a', 160), oc('b', 55)]);
  // A live pass that skipped one series (as the old method sometimes did) → the rebuild inserts that point.
  await db.query(
    `DELETE FROM oracle_prices WHERE id = (SELECT o.id FROM oracle_prices o JOIN markets m ON m.id = o.market_id
       WHERE m.symbol = 'INDEX:mtg:gp-top-100' ORDER BY o.source_observed_at LIMIT 1 OFFSET 1)`,
  );
  const plan1 = await planIndexRebuild(db, OPTS);
  const rep = await apply();
  assert.ok(rep.pointsInserted >= 1, 'the skipped pass got a point');
  assert.deepEqual(values(await planIndexRebuild(db, OPTS)), values(plan1), 're-planning after apply reproduces the same history');
});

test('R4: a pinned index is left alone, and a manual print is neither a pass nor rewritten', async () => {
  const top = await marketId('INDEX:mtg:top-100');
  await setManualPrice(db, top, 2_000_000_000n, { pin: true, operator: 'test' });
  const manual = (await db.query<{ t: Date }>(`SELECT source_observed_at AS t FROM oracle_prices WHERE market_id = $1 AND raw_payload->>'source' = 'manual'`, [top])).rows[0].t;
  const plan = await planIndexRebuild(db, OPTS);
  assert.ok(!plan.some((s) => s.symbol === 'INDEX:mtg:top-100'), 'the pinned index is not rebuilt');
  assert.ok(!plan.some((s) => s.points.some((p) => p.t.getTime() === manual.getTime())), 'no index gets a point at the manual timestamp');
  await apply();
  const latest = await db.query<{ m: string }>(`SELECT mark_price_e6::text AS m FROM marks WHERE market_id = $1 ORDER BY computed_at DESC LIMIT 1`, [top]);
  assert.equal(latest.rows[0].m, '2000000000', 'the pinned mark is untouched');
  await db.query(`UPDATE markets SET price_pinned = false WHERE id = $1`, [top]);
});

test('R1: apply refuses while an affected index has an open position (its live mark would jump)', async () => {
  const gp = await marketId('INDEX:mtg:gp-top-100');
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES('u-idx', 'pk-u-idx') ON CONFLICT DO NOTHING`);
  await db.query(
    `INSERT INTO positions(id, user_id, market_id, side, qty_e6, avg_entry_e6, margin_uusdc, leverage_e2, status, opened_at)
     VALUES('pos-idx', 'u-idx', $1, 'long', 1000000, 1000000000, 10000000, 200, 'open', now())`,
    [gp],
  );
  await assert.rejects(apply(), /open position/);
  await apply({ allowOpenPositions: true }); // an explicit, reviewed override goes through
  await db.query(`UPDATE positions SET status = 'closed', closed_at = now() WHERE id = 'pos-idx'`);
});

test('R5: revert refuses once a live pass chained off the rebuild (force overrides); it restores the exact basket snapshot', async () => {
  const gp = await marketId('INDEX:mtg:gp-top-100');
  const snap = async () => (await db.query<{ c: string; w: string }>(`SELECT card_id AS c, weight_e6::text AS w FROM index_constituents WHERE market_id = $1 ORDER BY card_id`, [gp])).rows;
  const rep = await apply();
  await ingest(db, async () => [oc('a', 170), oc('b', 56)]); // a live pass now chains off the rebuilt level
  await assert.rejects(revertHistoryRepair(db, rep.runId), /live oracle pass/);
  await revertHistoryRepair(db, rep.runId, { force: true });

  // Exact snapshot restore: make the stored basket differ from what a rebuild writes, rebuild, then revert.
  await db.query(`UPDATE index_constituents SET weight_e6 = weight_e6 + 7 WHERE market_id = $1`, [gp]);
  const s0 = await snap();
  const rep2 = await apply();
  assert.notDeepEqual(await snap(), s0, 'the rebuild rewrote the snapshot');
  await revertHistoryRepair(db, rep2.runId);
  assert.deepEqual(await snap(), s0, 'revert restores the exact pre-run snapshot');
});
