/**
 * Build/refresh the price_index data lake (docs §15): pull the raw TCGplayer market + the FULL price
 * payload from Scrydex and/or tcgpricelookup for every card whose raw market is ≥ the floor, keyed by
 * TCGplayer product_id. Writes ONLY to the `price_index` staging table — never the live `markets`.
 * Idempotent (upsert by product_id), so a re-run just refreshes.
 *
 *   DATABASE_URL=<prod> SCRYDEX_API_KEY=<k> SCRYDEX_TEAM_ID=<t> TCGPRICELOOKUP_API_KEY=<k> \
 *     npx tsx scripts/build-price-index.ts [--provider scrydex|tcgpl|both] [--min-usd 10] [--games pokemon,onepiece,mtg]
 *
 * Scrydex enum ≈ 1,500 requests (~75s). tcgpl full crawl ≈ 470 pages/game at 1 req/s (~25-30 min, low priority).
 */
import { config } from '../src/config.ts';
import { getDb, closeDb } from '../src/db/client.ts';
import { initDb } from '../src/db/init.ts';
import { importScrydexPrices, importTcgplPrices, PRICE_INDEX_MIN_USD } from '../src/services/price-index.ts';

const argv = process.argv;
const arg = (flag: string, def: string): string => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const provider = arg('--provider', 'both');
const minUsd = Number(arg('--min-usd', String(PRICE_INDEX_MIN_USD))) || PRICE_INDEX_MIN_USD;
const games = arg('--games', '').split(',').filter(Boolean);
const doScrydex = provider === 'scrydex' || provider === 'both';
const doTcgpl = provider === 'tcgpl' || provider === 'both';

if (doScrydex && (!config.scrydexApiKey || !config.scrydexTeamId)) {
  console.error('SCRYDEX_API_KEY and SCRYDEX_TEAM_ID required for the scrydex import');
  process.exit(1);
}
if (doTcgpl && !config.tcgpricelookupApiKey) {
  console.error('TCGPRICELOOKUP_API_KEY required for the tcgpl import');
  process.exit(1);
}

const opts = { minUsd, log: console.log, ...(games.length ? { games } : {}) };

await initDb();
const db = await getDb();
console.log(`build-price-index: provider=${provider} min-usd=${minUsd} games=${games.join(',') || 'all'}\n`);

if (doScrydex) {
  console.log('Scrydex enumerate (with prices)…');
  const r = await importScrydexPrices(db, opts);
  console.log(`Scrydex: scanned ${r.scanned} cards → stored ${r.stored} products\n`);
}
if (doTcgpl) {
  console.log('tcgpricelookup full crawl (slow — paced 1 req/s, low priority)…');
  const r = await importTcgplPrices(db, opts);
  console.log(`tcgpl: scanned ${r.scanned} cards → stored ${r.stored} products\n`);
}

const tot = await db.query<{ rows: string; with_scrydex: string; with_tcgpl: string; both: string }>(
  `SELECT count(*) AS rows,
          count(*) FILTER (WHERE scrydex_raw_usd IS NOT NULL) AS with_scrydex,
          count(*) FILTER (WHERE tcgpl_raw_usd IS NOT NULL)   AS with_tcgpl,
          count(*) FILTER (WHERE scrydex_raw_usd IS NOT NULL AND tcgpl_raw_usd IS NOT NULL) AS both
     FROM price_index`,
);
console.log('price_index now:', tot.rows[0]);
await closeDb();
