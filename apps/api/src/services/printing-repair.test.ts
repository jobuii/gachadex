import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// Wrong-printing repair (2026-10-18 plan P4, Q-B1/Q-B2): pre-fix Scrydex prints taken from another printing are
// rewritten in place to our printing's TCGplayer price, the wrong PSA-10 ladder is dropped, the chart marks follow,
// correct prints are untouched, and revert restores every row exactly.
process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { upsertCardMarket } = await import('./markets.ts');
const { planPrintingRepair, applyPrintingRepair, samePrinting } = await import('./printing-repair.ts');
const { revertHistoryRepair } = await import('./history-repair.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

const BPS = 2500;
async function market(sym: string, game: string, variant: string, tid: number, pick: string | null) {
  const id = await upsertCardMarket(db, { game, symbol: sym, cardId: sym, displayName: sym, variant, imageSmall: null, featured: true, tcgplayerId: tid });
  if (pick) await db.query(`INSERT INTO price_index(tcgplayer_id, game, scrydex_variant) VALUES($1, $2, $3)`, [tid, game, pick]);
  return id;
}
const payload = (sx: number, nm: number, ebay: number | null = null) => ({
  scrydex: { market: sx, currency: 'USD', graded: [{ grader: 'PSA', grade: '10', priceE6: '99000000000' }] },
  tcgpricelookup: { prices: { raw: { near_mint: { tcgplayer: { market: nm }, ...(ebay != null ? { ebay: { avg_1d: ebay } } : {}) } }, graded: { psa: { '10': { ebay: { avg_7d: 5000 } } } } } },
  gradedE6: '99000000000',
});
async function print(mid: string, at: string, usd: number, p: unknown, markUsd = usd) {
  const r = await db.query<{ id: string }>(
    `INSERT INTO oracle_prices(market_id, index_price_e6, raw_payload, source_observed_at, ingested_at) VALUES($1, $2, $3, $4, $4) RETURNING id::text`,
    [mid, BigInt(Math.round(usd * 1e6)).toString(), JSON.stringify(p), at],
  );
  await db.query(
    `INSERT INTO marks(market_id, mark_price_e6, index_price_e6, skew_uusdc, premium_e6, computed_at) VALUES($1, $2, $2, 0, 0, $3)`,
    [mid, BigInt(Math.round(markUsd * 1e6)).toString(), at],
  );
  return r.rows[0].id;
}

test('samePrinting: names that are one printing vs a real mismatch', () => {
  assert.equal(samePrinting('mtg', 'Foil', 'normal'), false);
  assert.equal(samePrinting('mtg', 'Normal', 'serializedFoil'), true);
  assert.equal(samePrinting('pokemon', 'Unlimited Holofoil', 'firstEditionHolofoil'), false);
  assert.equal(samePrinting('pokemon', '1st Edition Holofoil', 'firstEditionShadowlessHolofoil'), true);
  assert.equal(samePrinting('onepiece', 'Foil', 'wantedPoster'), true, 'One Piece names never compare — rule B only');
});

test('plan → apply → revert: rule A rewrites + mark replay; rule B; correct and unpriceable rows untouched', async () => {
  // Flooded Strand Foil (MTG), old pick "normal": Scrydex $110 vs our TCGplayer $1,200 → rule A.
  const fs = await market('mtg:fs', 'mtg', 'Foil', 10493, 'normal');
  await print(fs, '2026-05-16T18:00:00Z', 1203.33, { tcgpricelookup: { prices: {} } }); // pre-Scrydex: right
  const a1 = await print(fs, '2026-06-19T12:29:00Z', 110, payload(110, 1200), 902.5); // guard clamped 1203 → 902.50
  const a2 = await print(fs, '2026-07-01T00:00:00Z', 112, payload(112, 1210), 676.88);
  await print(fs, '2026-10-17T08:12:00Z', 1100, payload(1100, 1100), 1100); // post-fix: right, mark adopted at once
  // A correct market: same printing, prices agree → untouched.
  const ok = await market('pokemon:ok', 'pokemon', 'Holofoil', 2001, 'holofoil');
  const okPrint = await print(ok, '2026-07-01T00:00:00Z', 50, payload(50, 51));
  // One Piece after the fix: Scrydex $233 vs TCGplayer $1,522, eBay $1,250 sides with TCGplayer → rule B.
  const sh = await market('onepiece:shanks-gold', 'onepiece', 'Foil', 657442, 'wantedPoster');
  const b1 = await print(sh, '2026-10-17T20:00:00Z', 232.97, payload(232.97, 1522.2, 1250));
  // No TCGplayer price for our printing → nothing to put in its place → untouched.
  const np = await market('mtg:np', 'mtg', 'Foil', 3001, 'normal');
  await print(np, '2026-07-01T00:00:00Z', 20, { scrydex: { market: 20, currency: 'USD' }, tcgpricelookup: { prices: { raw: {} } } });

  const plan = await planPrintingRepair(db, { until: new Date('2026-10-18T00:00:00Z'), clampBps: BPS });
  assert.deepEqual(plan.rewrites.map((r) => [r.printId, r.newE6, r.rule]).sort(), [
    [a1, '1200000000', 'A'], [a2, '1210000000', 'A'], [b1, '1522200000', 'B'],
  ].sort());
  assert.ok(!plan.rewrites.some((r) => r.printId === okPrint));
  assert.deepEqual(plan.markRepairs.filter((m) => m.marketId === fs).map((m) => m.newE6), ['1200000000', '1210000000'], 'the chart follows the corrected prices and rejoins at the post-fix mark');

  const before = (await db.query(`SELECT id, index_price_e6::text AS v, raw_payload FROM oracle_prices ORDER BY id`)).rows;
  const beforeMarks = (await db.query(`SELECT id, mark_price_e6::text AS m FROM marks ORDER BY id`)).rows;
  const r = await applyPrintingRepair(db, plan);
  assert.equal(r.rewritten, 3, 'rows written = rows planned');
  const fixed = (await db.query<{ v: string; raw_payload: Record<string, unknown> }>(`SELECT index_price_e6::text AS v, raw_payload FROM oracle_prices WHERE id = $1`, [a1])).rows[0];
  assert.equal(fixed.v, '1200000000');
  assert.equal((fixed.raw_payload.scrydex as Record<string, unknown>).graded, undefined, 'the wrong printing\'s PSA-10 ladder is gone');
  assert.equal(fixed.raw_payload.gradedE6, undefined);

  await revertHistoryRepair(db, r.runId);
  assert.deepEqual((await db.query(`SELECT id, index_price_e6::text AS v, raw_payload FROM oracle_prices ORDER BY id`)).rows, before, 'revert restores every print exactly');
  assert.deepEqual((await db.query(`SELECT id, mark_price_e6::text AS m FROM marks ORDER BY id`)).rows, beforeMarks, 'and every mark');
});

test('not rewritten: a stamped promo whose Scrydex price equals its own TCGplayer price; ladder dropped on a confirmed market\'s other pre-fix prints', async () => {
  // Gyarados Staff: tcgpl "Holofoil", Scrydex pick "expansionStaffStamp" — its own product; LP $549.98 on both sides.
  assert.equal(samePrinting('pokemon', 'Holofoil', 'expansionStaffStamp'), true);
  const gy = await market('pokemon:gyarados-staff', 'pokemon', 'Holofoil', 126025, 'expansionStaffStamp');
  const lp = { scrydex: { market: 549.98, currency: 'USD', condition: 'LP' }, tcgpricelookup: { prices: { raw: { near_mint: { tcgplayer: { market: 417.29 } }, lightly_played: { tcgplayer: { market: 549.98 } } } } } };
  const g1 = await print(gy, '2026-08-01T00:00:00Z', 549.98, lp);
  // A rule-A market (MTG foil priced as normal) with one pre-fix print that is NOT rewritten (gap < 1.3): its ladder still goes.
  const bp = await market('mtg:birds', 'mtg', 'Foil', 2831, 'normal');
  const bad = await print(bp, '2026-08-01T00:00:00Z', 23, payload(23, 3980));
  const near = await print(bp, '2026-08-02T00:00:00Z', 3500, payload(3500, 3900));
  const plan = await planPrintingRepair(db, { until: new Date('2026-10-18T00:00:00Z'), clampBps: BPS });
  assert.ok(!plan.rewrites.some((r) => r.printId === g1), 'the stamped promo is untouched');
  assert.ok(plan.rewrites.some((r) => r.printId === bad));
  assert.ok(plan.ladderDrops.includes(near) && !plan.ladderDrops.includes(g1), 'ladder dropped on the confirmed market only');
  await applyPrintingRepair(db, plan);
  const n = (await db.query<{ v: string; raw_payload: Record<string, unknown> }>(`SELECT index_price_e6::text AS v, raw_payload FROM oracle_prices WHERE id = $1`, [near])).rows[0];
  assert.equal(n.v, '3500000000', 'value kept');
  assert.equal((n.raw_payload.scrydex as Record<string, unknown>).graded, undefined);
});
