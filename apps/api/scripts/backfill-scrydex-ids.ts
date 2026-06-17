/**
 * One-time ops script (P4 §8 cutover step 1): stamp each tracked card market with its Scrydex card id +
 * expansion id, so the price webhook can map an expansion event to our markets and the Scrydex feed can
 * fetch/price by id. Searches Scrydex by name and matches the variant whose TCGplayer product_id ==
 * our tcgplayer_id (Scrydex has no by-product_id filter — verified live). Dry-run by default.
 *
 *   DATABASE_URL=<prod> SCRYDEX_API_KEY=<k> SCRYDEX_TEAM_ID=<t> npx tsx scripts/backfill-scrydex-ids.ts          # dry run (report only)
 *   DATABASE_URL=<prod> SCRYDEX_API_KEY=<k> SCRYDEX_TEAM_ID=<t> npx tsx scripts/backfill-scrydex-ids.ts --apply  # write the ids
 *     --limit N   max markets this run (default 5000 — covers the whole tracked universe in one pass)
 *
 * Idempotent: only NULL scrydex_card_id rows are revisited; unmatched markets stay null and fall back to
 * tcgpl. ~1 credit per market (mostly matched on page 1), paced by the ProviderLimiter (~20/s) — a few
 * minutes for the universe. Each write is autonomous, so a mid-run failure just resumes on re-run.
 */
import { config } from '../src/config.ts';
import { getDb, closeDb } from '../src/db/client.ts';
import { initDb } from '../src/db/init.ts';
import { backfillScrydexIds } from '../src/services/providers/scrydex.ts';

if (!config.scrydexApiKey || !config.scrydexTeamId) {
  console.error('SCRYDEX_API_KEY and SCRYDEX_TEAM_ID must be set');
  process.exit(1);
}

const apply = process.argv.includes('--apply');
const limitIdx = process.argv.indexOf('--limit');
const limit = Number(limitIdx >= 0 ? process.argv[limitIdx + 1] : undefined) || 5000;

await initDb();
const db = await getDb();
console.log(`backfill-scrydex-ids: ${apply ? 'APPLY' : 'dry run'} (pass --apply to write), limit=${limit}\n`);

const r = await backfillScrydexIds(db, { apply, limit, log: console.log });

console.log(`\nmarkets needing a scrydex id: ${r.total}`);
console.log(`matched:   ${r.matched}${apply ? ` (written: ${r.applied})` : ' (dry run — nothing written)'}`);
console.log(`unmatched: ${r.unmatched.length} (stay null -> tcgpl fallback)`);
for (const u of r.unmatched) console.log(`  - ${u.name} (${u.id})`);

await closeDb();
