import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { scrydexVariantRawUsd, tplRawMarket, importScrydexPrices, importTcgplPrices } = await import('./price-index.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

type SxClient = Parameters<typeof importScrydexPrices>[1] extends { client?: infer C } ? C : never;
type TplClient = Parameters<typeof importTcgplPrices>[1] extends { client?: infer C } ? C : never;

const row = (tid: number) => db.query<Record<string, unknown>>(`SELECT * FROM price_index WHERE tcgplayer_id=$1`, [tid]).then((r) => r.rows[0]);

// --- unit: raw-price extraction ---
test('scrydexVariantRawUsd: NM market, LP fallback, JPY→USD via FX, JPY-no-rate → null', () => {
  assert.equal(scrydexVariantRawUsd([{ type: 'raw', condition: 'NM', market: 50, currency: 'USD' }], null), 50);
  assert.equal(scrydexVariantRawUsd([{ type: 'raw', condition: 'LP', market: 17.5, currency: 'USD' }], null), 17.5); // NM absent → LP
  assert.equal(scrydexVariantRawUsd([{ type: 'raw', condition: 'NM', market: 1500, currency: 'JPY' }], 0.0067), 1500 * 0.0067);
  assert.equal(scrydexVariantRawUsd([{ type: 'raw', condition: 'NM', market: 1500, currency: 'JPY' }], null), null);
  assert.equal(scrydexVariantRawUsd([{ type: 'graded', company: 'PSA', grade: '10', market: 999 }], null), null); // graded-only
  assert.equal(scrydexVariantRawUsd([{ type: 'raw', condition: 'NM', market: 1500, currency: 'EUR' }], 0.0067), null); // unknown currency → null (not mis-priced as USD)
});

test('tplRawMarket: TCGplayer market + eBay 7d from the best condition', () => {
  assert.deepEqual(tplRawMarket({ raw: { near_mint: { tcgplayer: { market: 42 }, ebay: { avg_7d: 40 } } } }), { rawUsd: 42, ebay7d: 40 });
  assert.deepEqual(tplRawMarket({ raw: { lightly_played: { tcgplayer: { market: 12 } } } }), { rawUsd: 12, ebay7d: null });
  assert.deepEqual(tplRawMarket({ raw: {} }), { rawUsd: null, ebay7d: null });
});

// --- import: Scrydex side, ≥$10 filter ---
const sxCard = (id: string, productId: number, market: number, currency = 'USD') => ({
  id, name: `Card ${id}`, expansion: { id: 'exp1' },
  variants: [{ name: 'holofoil', marketplaces: [{ name: 'tcgplayer', product_id: productId }], prices: [{ type: 'raw', condition: 'NM', market, currency }, { type: 'graded', company: 'PSA', grade: '10', market: 500 }] }],
});
const sxStub = (cards: unknown[]) =>
  ({ searchCards: async (_slug: string, p: { page: number }) => ({ data: p.page === 1 ? cards : [], total_count: cards.length, page: p.page, page_size: 100 }) }) as unknown as SxClient;

test('importScrydexPrices: stores only products ≥ minUsd (FX-converted), with the full variant payload', async () => {
  const r = await importScrydexPrices(db, {
    client: sxStub([sxCard('a', 1001, 50), sxCard('b', 1002, 5), sxCard('c', 1003, 1500, 'JPY')]),
    games: ['pokemon'],
    fx: async () => 0.0067,
  });
  assert.equal(r.scanned, 3);
  assert.equal(r.stored, 2, '$50 + the JPY ($10.05) stored; the $5 skipped');
  const a = await row(1001);
  assert.equal(a.scrydex_card_id, 'a');
  assert.equal(Number(a.scrydex_raw_usd), 50);
  assert.equal(a.game, 'pokemon');
  assert.ok(a.scrydex_prices, 'full payload stored'); // raw + graded kept
  assert.equal(await row(1002), undefined, 'sub-$10 not stored');
  assert.ok(await row(1003), 'JPY card ≥$10 after FX stored');
});

test('importScrydexPrices: counts ACTUAL cards across pages — a short non-last page does not break early', async () => {
  // total_count says 3, but the provider serves them one-per-page (short pages). With a page*BATCH
  // estimate the loop would break after page 1 (100 >= 3) and drop pages 2-3; cumulative-count fetches all.
  const pages = [[sxCard('pg1', 6001, 50)], [sxCard('pg2', 6002, 50)], [sxCard('pg3', 6003, 50)]];
  const stub = { searchCards: async (_s: string, p: { page: number }) => ({ data: pages[p.page - 1] ?? [], total_count: 3, page: p.page, page_size: 100 }) } as unknown as SxClient;
  const r = await importScrydexPrices(db, { client: stub, games: ['pokemon'], fx: async () => null });
  assert.equal(r.scanned, 3, 'all three short pages scanned (no early break)');
  assert.ok(await row(6003), 'the card on the last short page was stored');
});

// --- import: tcgpl side + the cross-feed MERGE on product_id ---
const tplCard = (tid: number, market: number, ebay7d: number | null) => ({
  id: `tpl-${tid}`, tcgplayer_id: String(tid), name: 'Card', number: '1', set: { slug: 's', name: 'Set One' },
  game: { slug: 'pokemon', name: 'Pokemon' }, prices: { raw: { near_mint: { tcgplayer: { market }, ebay: ebay7d != null ? { avg_7d: ebay7d } : {} } } },
});
const tplStub = (cards: unknown[]) =>
  ({ searchCards: async (p: { offset: number }) => ({ data: p.offset === 0 ? cards : [], total: cards.length, limit: 100, offset: p.offset }) }) as unknown as TplClient;

test('importTcgplPrices: stores ≥$10 and MERGES onto the same product row as Scrydex', async () => {
  // product 1001 already has the Scrydex side from the previous test; tcgpl writes its side onto the same row
  const r = await importTcgplPrices(db, { client: tplStub([tplCard(1001, 60, 55), tplCard(2002, 8, null)]), games: ['pokemon'] });
  assert.equal(r.stored, 1, 'only the $60 stored; the $8 skipped');
  const merged = await row(1001);
  assert.equal(Number(merged.scrydex_raw_usd), 50, 'Scrydex side preserved');
  assert.equal(Number(merged.tcgpl_raw_usd), 60, 'tcgpl side merged onto the same product_id');
  assert.equal(Number(merged.tcgpl_ebay_7d), 55);
  assert.equal(merged.tcgpl_card_id, 'tpl-1001');
  assert.ok(merged.tcgpl_prices, 'full tcgpl payload stored');
  assert.equal(await row(2002), undefined, 'sub-$10 tcgpl card not stored');
});
