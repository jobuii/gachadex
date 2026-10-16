import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// End-to-end through `ingest`: which cards enter which basket, and how the chained level moves. Hermetic DB.
process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.SEALED_INDEX_MIN_CONSTITUENTS = '2';
process.env.SEALED_INDEX_ENABLED = 'true';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { ingest } = await import('./oracle.ts');
const { listMarketsWithData } = await import('./markets.ts');
const { productTypeOf } = await import('./product-type.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

type PT = 'single' | 'sealed' | 'other';
const oc = (id: string, usd: number, productType: PT = 'single', featured = true) => ({
  game: 'mtg', symbol: `mtg:${id}`, cardId: id, displayName: id, variant: null, imageSmall: null,
  rawE6: BigInt(Math.round(usd * 1e6)), featured, productType,
});
const level = async (slug: string) => {
  const m = (await listMarketsWithData(db)).find((x) => x.game === 'mtg' && x.indexSlug === slug)!;
  return { market: m, value: m.markE6 == null ? null : Number(m.markE6) / 1e6 };
};
const basket = async (slug: string) => {
  const { market } = await level(slug);
  const r = await db.query<{ card_id: string }>(`SELECT card_id FROM index_constituents WHERE market_id=$1 ORDER BY card_id`, [market.id]);
  return r.rows.map((x) => x.card_id);
};

test('productTypeOf: sealed needs BOTH no rarity and no number; Code Card is other', () => {
  assert.equal(productTypeOf(null, null), 'sealed'); // "Hidden Legends Booster Box"
  assert.equal(productTypeOf('None', ''), 'sealed');
  assert.equal(productTypeOf('Rare', null), 'single'); // Alpha Mox Ruby: no number, but a rarity
  assert.equal(productTypeOf(null, '113'), 'single'); // a Japanese single with no rarity
  assert.equal(productTypeOf('Code Card', null), 'other');
});

test('sealed stays out of the card tiers, feeds its own GATED Sealed index; Code Cards are in neither', async () => {
  await ingest(db, async () => [
    oc('mox', 2000),
    oc('lotus', 1000),
    oc('alpha-box', 30_000, 'sealed'), // the priciest product — previously topped the "card" index
    oc('etb', 500, 'sealed'),
    oc('code', 5000, 'other'),
  ]);
  assert.deepEqual(await basket('top-100'), ['lotus', 'mox']);
  assert.deepEqual(await basket('sealed'), ['alpha-box', 'etb']);
  const sealed = await level('sealed');
  assert.equal(sealed.value, 1000, 'the Sealed index launches at its base');
  assert.equal(sealed.market.tradeable, false, 'built + listed, but only an operator lists it for trading');
  assert.equal((await level('top-100')).market.tradeable, true);
});

test('chained level: GJ = Σ ratio, G&P geometric, leavers count, the outlier guard holds', async () => {
  // Pass 2: mox +10%, lotus −10% (stays in the basket), the box doubles (excluded as an outlier).
  await ingest(db, async () => [oc('mox', 2200), oc('lotus', 900), oc('alpha-box', 60_000, 'sealed'), oc('etb', 500, 'sealed')]);
  assert.equal((await level('top-100')).value, Math.round(1e9 * (2200 + 900) / (2000 + 1000)) / 1e6); // GJ: 3100/3000 (stored e6)
  assert.equal(Math.round((await level('gp-top-100')).value! * 1000) / 1000, Math.round(1000 * Math.sqrt(1.1 * 0.9) * 1000) / 1000);
  assert.equal((await level('sealed')).value, 1000, 'the 2× box move is excluded; the ETB is flat');
});

test('a card whose price goes stale leaves the basket (no frozen price in an index)', async () => {
  // Age every mox print past INDEX_FRESH_MS (36h): it can no longer sit in a basket.
  await db.query(
    `UPDATE oracle_prices SET ingested_at = now() - interval '3 days'
      WHERE market_id = (SELECT id FROM markets WHERE symbol = 'mtg:mox')`,
  );
  // This pass's fetch does NOT include mox (the provider stopped returning it) → no fresh print for it.
  await ingest(db, async () => [oc('lotus', 900), oc('alpha-box', 60_000, 'sealed'), oc('etb', 500, 'sealed')]);
  assert.deepEqual(await basket('top-100'), ['lotus']);
});

// One Piece, isolated from the MTG cases above. A fixed provider timestamp means an unchanged price writes no
// new print (recordOracle dedup) — exactly how a tcgpl card goes stale in prod.
const op = (id: string, usd: number, featured = true) => ({
  game: 'onepiece', symbol: `onepiece:${id}`, cardId: id, displayName: `${id} #1`, variant: null, imageSmall: null,
  rawE6: BigInt(Math.round(usd * 1e6)), featured, productType: 'single' as const, observedAt: new Date(`2026-01-0${usd === 100 ? 1 : 2}T00:00:00Z`),
});
const opLevel = async (slug: string) => {
  const m = (await listMarketsWithData(db)).find((x) => x.game === 'onepiece' && x.indexSlug === slug)!;
  return { tradeable: m.tradeable, value: m.markE6 == null ? null : Number(m.markE6) / 1e6 };
};

test('a leaver that was DE-FEATURED still has its fall measured (not imputed away)', async () => {
  await ingest(db, async () => [op('luffy', 100), op('zoro', 100)]);
  assert.equal((await opLevel('top-100')).value, 1000);
  // zoro drops to $70 AND is de-featured at the weekly rebalance in the same pass: it leaves the basket,
  // but its −30% must still count — GJ = (100 + 70) / (100 + 100). (Imputed away, it would read 1000.)
  await ingest(db, async () => [op('luffy', 100), op('zoro', 70, false)]);
  assert.equal((await opLevel('top-100')).value, 850);
});

test('an already-live index stays tradeable through a pass with no fresh cards (never downgraded)', async () => {
  assert.equal((await opLevel('top-100')).tradeable, true);
  await db.query(`UPDATE oracle_prices SET ingested_at = ingested_at - interval '3 days' WHERE market_id IN (SELECT id FROM markets WHERE game = 'onepiece' AND kind = 'card')`);
  await ingest(db, async () => [op('luffy', 100)]); // same price + same provider timestamp → no new print → nothing fresh
  assert.equal((await opLevel('top-100')).tradeable, true, 'still tradeable (and so still in the liquidation sweep)');
});
