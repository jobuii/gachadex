import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { deriveUniverse } = await import('./universe.ts');

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
