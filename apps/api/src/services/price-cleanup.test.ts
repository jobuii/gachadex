import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { upsertCardMarket } = await import('./markets.ts');
const { fixedPriceFromPayload, planPriceCleanup, applyPriceCleanup } = await import('./price-cleanup.ts');
const { revertHistoryRepair } = await import('./history-repair.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

// Real-shaped payloads (oracle.ts / scrydex.ts store exactly these keys).
const tpl = (raw: Record<string, { m?: number; e?: number }>) => ({
  raw: Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, { tcgplayer: v.m != null ? { market: v.m } : undefined, ebay: v.e != null ? { avg_1d: v.e } : undefined }])),
});
const payload = (sx: { market: number; condition?: string } | null, raw: Record<string, { m?: number; e?: number }>) => ({
  scrydex: { id: sx ? 'sx1' : null, market: sx?.market ?? null, currency: 'USD', condition: sx?.condition ?? null, fxJpyUsd: null },
  tcgpricelookup: { prices: tpl(raw) },
});

test('rule P replay: would TODAY\'s fixed selection have printed this number?', () => {
  // Entei ☆ (no Scrydex anchor): printed $0.99 = tcgpl NM, but LP is $990 → fixed code reads LP $990 → reject.
  assert.equal(fixedPriceFromPayload(0.99, payload(null, { near_mint: { m: 0.99 }, lightly_played: { m: 990, e: 899 } })), 990);
  // Overgrown Tomb (Retro): consistent tcgpl rungs, eBay matched to the serial-numbered sibling → kept as printed.
  assert.equal(fixedPriceFromPayload(19.99, payload(null, { near_mint: { m: 19.99, e: 1845 }, lightly_played: { m: 15.86 } })), 19.99);
  // Lugia: Scrydex surviving LP rung $4,500, tcgpl fallback printed $500 → fixed keeps Scrydex.
  assert.equal(fixedPriceFromPayload(500, payload({ market: 4500, condition: 'LP' }, { lightly_played: { m: 500 } })), 4500);
  // A print that IS the Scrydex anchor → not a fallback print (null = rule P does not apply).
  assert.equal(fixedPriceFromPayload(100, payload({ market: 100 }, { near_mint: { m: 90 } })), null);
  // A backfilled print (graded only, no price inputs) → nothing to replay, never rejected.
  assert.equal(fixedPriceFromPayload(120, { backfill: { source: 'tcgpl' }, scrydex: { graded: null } }), null);
  // A pre-Scrydex-era print (no scrydex key) → not this code path.
  assert.equal(fixedPriceFromPayload(5, { tcgpricelookup: { prices: tpl({ near_mint: { m: 5 } }) } }), null);
});

const mk = (id: string) => upsertCardMarket(db, { game: 'pokemon', symbol: `pokemon:${id}`, cardId: id, displayName: `${id} #1`, variant: null, imageSmall: null });
const print = (marketId: string, usd: number, daysAgo: number, p: unknown = null) =>
  db.query(
    `INSERT INTO oracle_prices(market_id, index_price_e6, raw_payload, source_observed_at, ingested_at)
     VALUES($1, $2, $3, now() - ($4 || ' days')::interval, now() - ($4 || ' days')::interval)`,
    [marketId, Math.round(usd * 1e6), JSON.stringify(p), String(daysAgo)],
  );

test('plan: P rejects placeholders, E rejects reverted excursions, S only reports persistent shifts; exposure listed', async () => {
  const entei = await mk('entei');
  await print(entei, 0.99, 30, payload(null, { near_mint: { m: 0.99 }, lightly_played: { m: 990, e: 899 } }));
  await print(entei, 0.99, 20, payload(null, { near_mint: { m: 0.99 }, lightly_played: { m: 990, e: 899 } }));
  await print(entei, 1067, 10, payload({ market: 1067 }, {}));

  const kid = await mk('kid');
  await print(kid, 957, 12);
  await print(kid, 5.51, 11); // one-print crash…
  await print(kid, 950, 10.5); // …back within a day → rule E

  const birds = await mk('birds');
  await print(birds, 19, 40);
  await print(birds, 3960, 30); // never comes back → review only (rule S)
  await print(birds, 3960, 5);

  // a position open on Kid during the bad print
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES('u1', 'pk-u1')`);
  await db.query(
    `INSERT INTO positions(id, user_id, market_id, side, qty_e6, avg_entry_e6, margin_uusdc, leverage_e2, status, opened_at)
     VALUES('pos1', 'u1', $1, 'long', 1000000, 957000000, 10000000, 200, 'open', now() - interval '13 days')`,
    [kid],
  );

  const plan = await planPriceCleanup(db);
  const by = (m: string) => plan.rejected.filter((r) => r.marketId === m);
  assert.deepEqual(by(entei).map((r) => r.rule), ['P', 'P'], 'both $0.99 placeholder prints');
  assert.deepEqual(by(kid).map((r) => [r.rule, r.printedUsd]), [['E', 5.51]]);
  assert.equal(by(birds).length, 0, 'a persistent shift is never auto-rejected…');
  assert.ok(plan.review.some((r) => r.marketId === birds && r.toUsd === 3960), '…it is reported for review');
  assert.ok(plan.exposures.some((e) => e.positionId === 'pos1'), 'the position open during the bad window is surfaced');
});

test('apply rejects them (reversibly); the live baseline skips them; revert re-accepts', async () => {
  const plan = await planPriceCleanup(db);
  const { runId, rejected } = await applyPriceCleanup(db, plan);
  assert.equal(rejected, plan.rejected.length);
  const live = await db.query(`SELECT count(*)::int AS n FROM oracle_prices WHERE is_accepted = false AND reject_reason LIKE 'cleanup%'`);
  assert.equal(live.rows[0].n, rejected);
  assert.equal((await planPriceCleanup(db)).rejected.length, 0, 'idempotent: nothing left to reject');
  await revertHistoryRepair(db, runId);
  const back = await db.query(`SELECT count(*)::int AS n FROM oracle_prices WHERE is_accepted = false`);
  assert.equal(back.rows[0].n, 0, 'revert re-accepts every print');
});

test('rule E compares to the last ACCEPTED value — never to a glitch it just rejected (review R3)', async () => {
  const m = await mk('flipper');
  const vals = [100, 1, 100, 100, 1, 100, 100];
  for (let i = 0; i < vals.length; i++) await print(m, vals[i], 10 - i * 0.5);
  const plan = await planPriceCleanup(db);
  assert.deepEqual(plan.rejected.filter((r) => r.marketId === m).map((r) => r.printedUsd), [1, 1], 'only the two glitches');
  assert.equal(plan.review.filter((r) => r.marketId === m).length, 0, 'no bogus "$1 → $100" review item');
});
