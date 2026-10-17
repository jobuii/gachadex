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

test('chart marks replay as if rejected prints never landed — incl. the mark guard\'s catch-up; positions + live mark kept; rule M; revert', async () => {
  const mark = (marketId: string, usd: number, daysAgo: number) =>
    db.query(`INSERT INTO marks(market_id, mark_price_e6, index_price_e6, computed_at) VALUES($1, $2, $2, now() - ($3 || ' days')::interval)`, [marketId, Math.round(usd * 1e6), String(daysAgo)]);
  const markVals = async (m: string) => (await db.query<{ v: string }>(`SELECT mark_price_e6::text AS v FROM marks WHERE market_id = $1 ORDER BY computed_at`, [m])).rows.map((r) => Number(r.v) / 1e6);
  const at = async (m: string, k: number) => (await db.query<{ id: string }>(`SELECT id::text AS id FROM oracle_prices WHERE market_id = $1 ORDER BY ingested_at`, [m])).rows[k].id;

  // X: a 2-print down glitch (rule E). The guard clamped the marks down 25%/update and, after it, climbed back 25%/update
  // on GOOD prints (the review's tail) — every one of those replays to the print's own price, until one already matches.
  const x = await mk('mox-x');
  for (const [usd, d, m] of [[100, 10, 100], [40, 9, 75], [40, 8.9, 56.25], [100, 8.5, 70.3125], [100, 8.4, 87.890625], [100, 8.3, 100], [101, 8, 101]]) {
    await print(x, usd, d);
    await mark(x, m, d);
  }
  // Y: the same glitch while a position was open → the trading record stands.
  const y = await mk('mox-y');
  for (const [usd, d] of [[100, 10], [40, 9], [100, 8]]) { await print(y, usd, d); await mark(y, usd, d); }
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES('u-y', 'pk-u-y') ON CONFLICT DO NOTHING`);
  await db.query(
    `INSERT INTO positions(id, user_id, market_id, side, qty_e6, avg_entry_e6, margin_uusdc, leverage_e2, status, opened_at, closed_at)
     VALUES('pos-y', 'u-y', $1, 'long', 1000000, 100000000, 10000000, 200, 'closed', now() - interval '9.5 days', now() - interval '8.8 days')`,
    [y],
  );
  // Z: a 1.9× one-day excursion no rule catches (the One Ring backfill print) → rule M.
  const z = await mk('ring-z');
  for (const [usd, d] of [[700, 10], [1330, 9], [740, 8], [760, 1]]) { await print(z, usd, d); await mark(z, usd, d); }
  // W: an earlier run rejected the card's LATEST print → its mark is the live price, left alone.
  const w = await mk('delisted-w');
  for (const [usd, d] of [[300, 10], [30, 9]]) { await print(w, usd, d); await mark(w, usd, d); }
  await db.query(`UPDATE oracle_prices SET is_accepted = false, reject_reason = 'cleanup earlier-run: test' WHERE id = $1`, [await at(w, 1)]);

  await assert.rejects(planPriceCleanup(db, { reject: ['999999999'] }), /not an accepted card print: 999999999/);
  await assert.rejects(planPriceCleanup(db, { reject: [await at(z, 3)] }), /latest print/);
  const plan = await planPriceCleanup(db, { reject: [await at(z, 1)] });
  assert.deepEqual(plan.rejected.filter((r) => r.marketId === z).map((r) => r.rule), ['M']);
  assert.equal(plan.markRepairs.filter((r) => r.marketId === y).length, 0, 'a position was open → left as the trading record');
  assert.equal(plan.markRepairs.filter((r) => r.marketId === w).length, 0, 'the live mark is left alone');
  assert.ok(plan.marksKept.position >= 1 && plan.marksKept.live >= 1);

  const before = { x: await markVals(x), z: await markVals(z) };
  const r = await applyPriceCleanup(db, plan);
  assert.deepEqual(await markVals(x), [100, 100, 100, 100, 100, 100, 101], 'glitch → $100, and the guard\'s climb back → each print\'s own $100');
  assert.deepEqual(await markVals(y), [100, 40, 100]);
  assert.deepEqual(await markVals(z), [700, 700, 740, 760]);
  assert.deepEqual(await markVals(w), [300, 30]);
  assert.equal((await planPriceCleanup(db)).markRepairs.filter((m) => [x, z].includes(m.marketId)).length, 0, 'idempotent');

  await revertHistoryRepair(db, r.runId);
  assert.deepEqual({ x: await markVals(x), z: await markVals(z) }, before, 'revert restores every mark exactly');
});

test('a rule-M print is out of the rule E/S scan — it never "reverts" a real drop (review 2026-10-17)', async () => {
  const m = await mk('m-scan');
  for (const [usd, d] of [[100, 6], [45, 5], [95, 4], [45, 3], [45, 2]]) await print(m, usd, d);
  const m95 = (await db.query<{ id: string }>(`SELECT id::text AS id FROM oracle_prices WHERE market_id = $1 ORDER BY ingested_at`, [m])).rows[2].id;
  const plan = await planPriceCleanup(db, { reject: [m95] });
  assert.deepEqual(plan.rejected.filter((r) => r.marketId === m).map((r) => r.rule), ['M'], '100 → 45 that stays is a real drop, not an excursion');
});

test('a rejected run still catching up at the live mark (a frozen delisted card) is left whole — no cliff into the live price', async () => {
  const m = await mk('frozen-v');
  for (const [usd, d, mark] of [[100, 6, 100], [40, 5, 75], [100, 4, 93.75]]) {
    await print(m, usd, d);
    await db.query(`INSERT INTO marks(market_id, mark_price_e6, index_price_e6, computed_at) VALUES($1, $2, $2, now() - ($3 || ' days')::interval)`, [m, Math.round(mark * 1e6), String(d)]);
  }
  const plan = await planPriceCleanup(db);
  assert.deepEqual(plan.rejected.filter((r) => r.marketId === m).map((r) => r.printedUsd), [40]);
  assert.equal(plan.markRepairs.filter((r) => r.marketId === m).length, 0, 'the 75 → 93.75 climb ends at the live mark: kept whole');
});

test('a rejected print holds the replayed line — it never pulls the chart to an older print the guard was still easing toward (Mox Pearl)', async () => {
  const m = await mk('mox-pearl-like');
  // The guard was easing $5,500 → $1,338.58 (mark $4,125) when a $0.03 placeholder landed: its clamped mark $3,093.75.
  for (const [usd, d, mark] of [[5500, 10, 5500], [1338.58, 9, 4125], [0.03, 8.5, 3093.75], [3200, 8, 3200], [3210, 7, 3210]]) {
    await print(m, usd, d);
    await db.query(`INSERT INTO marks(market_id, mark_price_e6, index_price_e6, computed_at) VALUES($1, $2, $2, now() - ($3 || ' days')::interval)`, [m, Math.round(mark * 1e6), String(d)]);
  }
  const bad = (await db.query<{ id: string }>(`SELECT id::text AS id FROM oracle_prices WHERE market_id = $1 ORDER BY ingested_at`, [m])).rows[2].id;
  const plan = await planPriceCleanup(db, { reject: [bad], clampBps: 2500 });
  assert.deepEqual(plan.markRepairs.filter((r) => r.marketId === m).map((r) => Number(r.newE6) / 1e6), [4125], 'no mark would have been made: the line holds at $4,125');
});

test('marks the guard clamped after a rejected print are re-clamped from the replayed line (25%/update), until it rejoins', async () => {
  const m = await mk('reclamp');
  for (const [usd, d, mark] of [[100, 10, 100], [40, 9, 75], [200, 8, 93.75], [200, 7, 117.1875], [200, 6, 146.484375], [200, 5, 183.105468], [200, 4, 200], [201, 3, 201]]) {
    await print(m, usd, d);
    await db.query(`INSERT INTO marks(market_id, mark_price_e6, index_price_e6, computed_at) VALUES($1, $2, $2, now() - ($3 || ' days')::interval)`, [m, Math.round(mark * 1e6), String(d)]);
  }
  const bad = (await db.query<{ id: string }>(`SELECT id::text AS id FROM oracle_prices WHERE market_id = $1 ORDER BY ingested_at`, [m])).rows[1].id;
  const plan = await planPriceCleanup(db, { reject: [bad], clampBps: 2500 });
  assert.deepEqual(plan.markRepairs.filter((r) => r.marketId === m).map((r) => Number(r.newE6) / 1e6), [100, 125, 156.25, 195.3125, 200]);
});

// [price, daysAgo, mark, backfill?] rows → a card's prints + marks; returns the print ids.
async function card(name: string, rows: [number, number, number, boolean?][]) {
  const m = await mk(name);
  for (const [usd, d, mark, bf] of rows) {
    await print(m, usd, d, bf ? { backfill: { runId: 'test' } } : null);
    await db.query(`INSERT INTO marks(market_id, mark_price_e6, index_price_e6, computed_at) VALUES($1, $2, $2, now() - ($3 || ' days')::interval)`, [m, Math.round(mark * 1e6), String(d)]);
  }
  const ids = (await db.query<{ id: string }>(`SELECT id::text AS id FROM oracle_prices WHERE market_id = $1 ORDER BY ingested_at`, [m])).rows.map((r) => r.id);
  return { m, ids };
}
const repairsFor = async (m: string, reject: string[]) =>
  (await planPriceCleanup(db, { reject, clampBps: 2500 })).markRepairs.filter((r) => r.marketId === m).map((r) => Number(r.newE6) / 1e6);

test('review round 2: a position open mid-run keeps the whole run (no wiggle into the trading record)', async () => {
  const { m, ids } = await card('pos-mid', [[100, 10, 100], [40, 9, 75], [200, 8, 93.75], [200, 7, 117.1875], [200, 2, 146.484375], [201, 1, 201]]);
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES('u-pm', 'pk-u-pm') ON CONFLICT DO NOTHING`);
  await db.query(
    `INSERT INTO positions(id, user_id, market_id, side, qty_e6, avg_entry_e6, margin_uusdc, leverage_e2, status, opened_at, closed_at)
     VALUES('pos-pm', 'u-pm', $1, 'long', 1000000, 100000000, 10000000, 200, 'closed', now() - interval '3 days', now() - interval '1.5 days')`,
    [m],
  );
  assert.deepEqual(await repairsFor(m, [ids[1]]), [], 'the d2 mark was traded against → the run before it stays too');
});

test('review round 2: a mark that equalled its print only because the move was inside the band is re-guarded', async () => {
  // 108.45 → 16.40 (rejected; mark clamped to 81.3375) → 68.89 is −15% from 81.34: inside the band, so live adopted it.
  // Without the glitch the anchor is 108.45 and 68.89 is −36%: the guard would have clamped to 81.3375.
  const { m, ids } = await card('in-band', [[108.45, 10, 108.45], [16.4, 9, 81.3375], [68.89, 8, 68.89], [68.89, 7, 68.89]]);
  assert.deepEqual(await repairsFor(m, [ids[1]]), [108.45, 81.3375], 'then 81.34 → 68.89 is inside the band: rejoins');
});

test('review round 2: a gap-day backfill point is never the guard\'s anchor — the run continues through it', async () => {
  const { m, ids } = await card('bf-mid', [[100, 10, 100], [40, 9, 75], [100, 8.5, 100, true], [100, 8, 93.75], [100, 7, 100]]);
  assert.deepEqual(await repairsFor(m, [ids[1]]), [100, 100], 'the live 93.75 (clamped from 75, not from the backfill point) is fixed too');
});

test('review round 2: a clamp the guard formula does not reproduce (e.g. another mark_clamp_bps then) keeps the run whole', async () => {
  const { m, ids } = await card('other-bps', [[100, 10, 100], [40, 9, 80], [100, 8, 96], [100, 7, 100]]); // 20% clamps
  const plan = await planPriceCleanup(db, { reject: [ids[1]], clampBps: 2500 });
  assert.deepEqual(plan.markRepairs.filter((r) => r.marketId === m), []);
  assert.ok(plan.marksKept.unexplained >= 2);
});
