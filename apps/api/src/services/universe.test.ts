import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { deriveUniverse, applyUniverse } = await import('./universe.ts');
const { upsertCardMarket, listMarketsWithData } = await import('./markets.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

const rawUsd = (m: number) => JSON.stringify([{ type: 'raw', condition: 'NM', market: m, currency: 'USD' }]);
const rawJpy = (m: number) => JSON.stringify([{ type: 'raw', condition: 'NM', market: m, currency: 'JPY' }]);

interface Seed { tid: number; game: string; name: string; sxUsd?: number; sxPrices?: string; tpUsd?: number }
async function seed(rows: Seed[]) {
  for (const r of rows)
    await db.query(
      `INSERT INTO price_index (tcgplayer_id, game, name, scrydex_card_id, scrydex_raw_usd, scrydex_prices, tcgpl_card_id, tcgpl_raw_usd)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (tcgplayer_id) DO NOTHING`,
      [r.tid, r.game, r.name, `sx-${r.tid}`, r.sxUsd ?? null, r.sxPrices ?? null, r.tpUsd != null ? `tp-${r.tid}` : null, r.tpUsd ?? null],
    );
}

test('deriveUniverse: EN top-N by per-game feed + JPY floor set + requiresScrydex gating', async () => {
  await seed([
    { tid: 101, game: 'pokemon', name: 'P1', sxUsd: 500, sxPrices: rawUsd(500), tpUsd: 400 }, // EN rank1, both feeds
    { tid: 102, game: 'pokemon', name: 'P2', sxUsd: 300, sxPrices: rawUsd(300) }, // EN rank2, Scrydex-only → requiresScrydex
    { tid: 103, game: 'pokemon', name: 'P3', sxUsd: 100, sxPrices: rawUsd(100), tpUsd: 90 }, // EN rank3 → excluded at topN=2
    { tid: 201, game: 'pokemon', name: 'PJ1', sxUsd: 150, sxPrices: rawJpy(22500) }, // JP ≥$100 → jpy set
    { tid: 202, game: 'pokemon', name: 'PJ2', sxUsd: 50, sxPrices: rawJpy(7500) }, // JP <$100 → excluded
    { tid: 301, game: 'onepiece', name: 'O1', sxUsd: 200, sxPrices: rawUsd(200), tpUsd: 600 }, // OP prefers tcgpl → 600
    { tid: 302, game: 'onepiece', name: 'O2', tpUsd: 300 }, // tcgpl-only but priced → not requiresScrydex
  ]);
  const u = await deriveUniverse(db, { topN: 2, jpyFloorUsd: 100, games: ['pokemon', 'onepiece'] });
  assert.equal(u.summary.total, 5);
  assert.deepEqual(u.summary.byGame.pokemon, { enTop: 2, jpyFloor: 1 });
  assert.deepEqual(u.summary.byGame.onepiece, { enTop: 2, jpyFloor: 0 });
  assert.equal(u.summary.requiresScrydex, 2); // P2 + PJ1

  const by = Object.fromEntries(u.markets.map((m) => [m.tcgplayerId, m]));
  assert.equal(by[101].chosenUsd, 500, 'pokemon prefers Scrydex price');
  assert.equal(by[301].chosenUsd, 600, 'onepiece prefers tcgpl price');
  assert.equal(by[102].requiresScrydex, true, 'no tcgpl price → requiresScrydex');
  assert.equal(by[302].requiresScrydex, false, 'tcgpl price present → not requiresScrydex');
  assert.equal(by[201].lang, 'jp');
  assert.equal(by[201].reason, 'jpy-floor');
  assert.equal(by[101].reason, 'en-top');
  assert.equal(by[103], undefined, 'EN rank 3 excluded at topN=2');
  assert.equal(by[202], undefined, 'JP <$100 excluded');
});

// Stub Scrydex client: returns a minimal card per requested id (enough for fromScrydexCard).
const scrydexStub = {
  getCardsByIds: async (_slug: string, ids: string[]) =>
    ids.map((id) => ({ id, name: `Card ${id}`, number: '1', rarity: 'Rare', expansion: { id: 'exp1', name: 'Exp One' }, images: [{ type: 'front', small: `${id}-s`, large: `${id}-l` }], variants: [] })),
} as unknown as Parameters<typeof applyUniverse>[2] extends { scrydex?: infer C } ? C : never;
const marketByTid = (tid: number) =>
  db.query<Record<string, unknown>>(`SELECT id, featured, requires_scrydex, scrydex_card_id FROM markets WHERE tcgplayer_id=$1`, [tid]).then((r) => r.rows[0]);

test('applyUniverse: creates entrants (hidden flag), re-features stays, un-features drop-outs', async () => {
  // mtg price_index (isolated from the pokemon/onepiece rows above)
  await seed([
    { tid: 5001, game: 'mtg', name: 'M1', sxUsd: 500, sxPrices: rawUsd(500), tpUsd: 400 }, // both feeds → not requiresScrydex
    { tid: 5002, game: 'mtg', name: 'M2', sxUsd: 300, sxPrices: rawUsd(300) }, // Scrydex-only → requiresScrydex
  ]);
  // existing markets: 5001 featured (will stay), 9999 featured but NOT derived (will drop)
  await upsertCardMarket(db, { game: 'mtg', symbol: 'mtg:tp-5001', cardId: 'tp-5001', displayName: 'M1', variant: null, imageSmall: null, tcgplayerId: 5001, providerCardId: 'tp-5001', featured: true });
  await upsertCardMarket(db, { game: 'mtg', symbol: 'mtg:tp-9999', cardId: 'tp-9999', displayName: 'Old', variant: null, imageSmall: null, tcgplayerId: 9999, providerCardId: 'tp-9999', featured: true });

  const u = await deriveUniverse(db, { topN: 5, jpyFloorUsd: 100, games: ['mtg'] });
  const dry = await applyUniverse(db, u, { scrydex: scrydexStub });
  assert.deepEqual({ c: dry.toCreate, u: dry.toUpdate, d: dry.toUnfeature, created: dry.created }, { c: 1, u: 1, d: 1, created: 0 }, 'dry-run plans but writes nothing');
  assert.equal(await marketByTid(5002), undefined, 'dry-run created no market');

  const res = await applyUniverse(db, u, { apply: true, scrydex: scrydexStub });
  assert.equal(res.created, 1); // 5002
  assert.equal(res.updated, 1); // 5001
  assert.equal(res.unfeatured, 1); // 9999
  assert.equal(res.fetchFailures, 0);

  const m5002 = await marketByTid(5002);
  assert.ok(m5002, 'entrant 5002 created');
  assert.equal(m5002.featured, true);
  assert.equal(m5002.requires_scrydex, true, 'Scrydex-only entrant flagged hidden-until-flip');
  assert.equal(m5002.scrydex_card_id, 'sx-5002');
  assert.equal((await marketByTid(5001)).featured, true, 'stay stays featured');
  assert.equal((await marketByTid(9999)).featured, false, 'drop-out un-featured (status untouched)');
});

test('listMarketsWithData hides requires_scrydex markets under non-scrydex primary', async () => {
  // env ORACLE_PRIMARY is unset here → config.oraclePrimary='pokemontcg' (not scrydex)
  const view = await listMarketsWithData(db);
  const bySym = new Set(view.map((m) => m.symbol));
  assert.ok(!bySym.has('mtg:sx-5002'), 'Scrydex-only market hidden until the flip');
  assert.ok(bySym.has('mtg:tp-5001'), 'tcgpl-priceable market stays visible');
});
