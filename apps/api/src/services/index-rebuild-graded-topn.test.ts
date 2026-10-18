import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// graded_prints must make the rebuilt Graded index equal the live one in the cases a "newer than the last print"
// rule got wrong (2026-10-17 review): a card leaving and re-entering the top-N, JustTCG-fallback PSA-10s, a leaver's
// PSA-10 move, and a pass with no PSA-10 at all. Top-1 Graded basket so membership changes are easy to drive.
process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.GRADED_CONSTITUENTS = '1';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { config } = await import('../config.ts');
const { ingest } = await import('./oracle.ts');
const { planIndexRebuild, applyIndexRebuild } = await import('./index-rebuild.ts');
const { withIngestLease } = await import('./history-repair.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

const OPTS = { freshMs: config.indexFreshMs, outlierFactor: config.indexOutlierFactor, gradedConstituents: 1, sealedMin: 5, sealedEnabled: false, gapFill: false };
const NOW = Date.now();
const t = (h: number) => new Date(NOW - h * 3_600_000); // fixed, so the same snapshot really is the same
// observedAt = the provider snapshot time: the same one again + the same raw ⇒ no new card print.
const oc = (id: string, usd: number, at: Date, psa10: number | null) => ({
  game: 'pokemon', symbol: `pokemon:${id}`, cardId: id, displayName: `${id} #1`, variant: null, imageSmall: null,
  rawE6: BigInt(usd * 1e6), gradedE6: psa10 == null ? null : BigInt(psa10 * 1e6), observedAt: at, featured: true, productType: 'single' as const,
});
const liveGraded = async () =>
  (
    await db.query<{ v: string }>(
      `SELECT o.index_price_e6::text AS v FROM oracle_prices o JOIN markets m ON m.id = o.market_id WHERE m.symbol = 'INDEX:graded' ORDER BY o.ingested_at`,
    )
  ).rows.map((r) => Number(r.v) / 1e6);
const reset = () => db.query(`TRUNCATE graded_prints, marks, oracle_prices, index_constituents, markets RESTART IDENTITY CASCADE`);

/** Run the passes, then: rebuild == live pass for pass, and after applying it one more unchanged pass doesn't move. */
async function rebuildMatchesLive(passes: { cards: ReturnType<typeof oc>[]; fetcher?: (c: { cardId: string }) => Promise<number | null> }[]) {
  for (const p of passes) await ingest(db, async () => p.cards, (p.fetcher ?? null) as never);
  const live = await liveGraded();
  const rebuilt = (await planIndexRebuild(db, OPTS)).find((s) => s.symbol === 'INDEX:graded')!.points.map((x) => Number(x.value) / 1e6);
  assert.deepEqual(rebuilt, live, 'the rebuild reproduces the live Graded index');
  await withIngestLease(db, async () => applyIndexRebuild(db, await planIndexRebuild(db, OPTS), () => {}));
  const lastPass = passes[passes.length - 1];
  await ingest(db, async () => lastPass.cards, (lastPass.fetcher ?? null) as never);
  const after = await liveGraded();
  // (an empty Graded basket prints nothing — then there is no step to measure)
  if (after.length > live.length) assert.equal(after[after.length - 1], after[after.length - 2], `no step at the first live pass after the rebuild: ${after}`);
  return live;
}

test('a card that leaves the top-N and re-enters with a PSA-10 its last print never carried', async () => {
  await reset();
  const live = await rebuildMatchesLive([
    { cards: [oc('a', 100, t(9), 1000), oc('b', 50, t(9), 500)] },
    { cards: [oc('a', 90, t(8), 1200), oc('b', 200, t(8), 500)] }, // b overtakes; a prints with an inline 1,200
    { cards: [oc('a', 90, t(8), 1000), oc('b', 80, t(7), 500)] }, // a back to 1,000 with no print, re-enters
  ]);
  assert.ok(new Set(live).size > 1, `the index moved: ${live}`);
});

test('a JustTCG-fallback PSA-10 (never on a print) stays in the history across raw moves', async () => {
  await reset();
  const fetcher = async (c: { cardId: string }) => (c.cardId === 'a' ? 1000 : null);
  await rebuildMatchesLive([
    { cards: [oc('a', 100, t(9), null), oc('b', 50, t(9), 600)], fetcher },
    { cards: [oc('a', 110, t(8), null), oc('b', 50, t(9), 600)], fetcher },
    { cards: [oc('a', 120, t(7), null), oc('b', 50, t(9), 900)], fetcher },
  ]);
});

test('a leaver\'s PSA-10 move is measured in the history as it was live', async () => {
  await reset();
  const live = await rebuildMatchesLive([
    { cards: [oc('a', 100, t(9), 1000), oc('b', 50, t(9), 500)] },
    { cards: [oc('a', 100, t(9), 1500), oc('b', 200, t(8), 500)] }, // b overtakes as a's PSA-10 jumps (no a print)
    { cards: [oc('a', 100, t(9), 1500), oc('b', 200, t(8), 520)] },
  ]);
  assert.ok(new Set(live).size > 1, `the index moved: ${live}`);
});

test('a pass with no PSA-10 drops the card, in the history too — not the PSA-10 its last print stored', async () => {
  await reset();
  // a's print stores an inline PSA-10; later passes have none (provider dropped it, the fallback finds nothing).
  await ingest(db, async () => [oc('a', 100, t(9), 1000), oc('b', 50, t(9), 500)]);
  await rebuildMatchesLive([
    { cards: [oc('a', 100, t(9), null), oc('b', 50, t(8), 520)], fetcher: async () => null },
    { cards: [oc('a', 100, t(9), null), oc('b', 50, t(7), 540)], fetcher: async () => null },
  ]);
});

test('a card that goes stale (no fresh raw print) is a leaver whose PSA-10 move is still measured — in the history too', async () => {
  await reset();
  await ingest(db, async () => [oc('a', 100, t(80), 1000), oc('b', 50, t(80), 500)]);
  // That pass happened 3 days ago: age everything it wrote, so a's raw print is now beyond INDEX_FRESH_MS.
  for (const [tbl, cols] of [['oracle_prices', ['ingested_at', 'source_observed_at']], ['marks', ['computed_at']], ['graded_prints', ['observed_at']], ['featured_events', ['at']], ['market_status_events', ['at']]] as const) {
    await db.query(`UPDATE ${tbl} SET ${cols.map((c) => `${c} = ${c} - interval '3 days'`).join(', ')}`);
  }
  const aged = new Date(t(80).getTime() - 3 * 86_400_000); // a's provider snapshot, re-served unchanged → no new print
  const live = await rebuildMatchesLive([
    { cards: [oc('a', 100, aged, 1500), oc('b', 50, t(1), 500)] }, // a's PSA-10 jumps while it is stale
    { cards: [oc('a', 100, aged, 1500), oc('b', 50, t(1), 510)] },
  ]);
  assert.ok(new Set(live).size > 1, `the index moved: ${live}`);
});
