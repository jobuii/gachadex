/**
 * One-time ops script (P1): stamp existing card markets with their tcgpricelookup identity so the
 * P5 cutover re-prices them in place. Conservative matching; dry-run by default.
 *
 *   DATABASE_URL=<prod-postgres> TCGPRICELOOKUP_API_KEY=<key> npx tsx scripts/backfill-provider-ids.ts          # dry run (report only)
 *   DATABASE_URL=<prod-postgres> TCGPRICELOOKUP_API_KEY=<key> npx tsx scripts/backfill-provider-ids.ts --apply  # write the ids
 *
 * ~258 markets at the provider's 1 req/s ≈ 5 minutes. Idempotent (only NULL provider_card_id rows);
 * unmatched/ambiguous rows are reported for the operator, never guessed.
 */
import { config } from '../src/config.ts';
import { getDb, closeDb } from '../src/db/client.ts';
import { initDb } from '../src/db/init.ts';
import { TcgPriceLookupClient } from '../src/services/providers/tcgpricelookup.ts';
import { backfillProviderIds } from '../src/services/providers/backfill.ts';

if (!config.tcgpricelookupApiKey) {
  console.error('TCGPRICELOOKUP_API_KEY is not set');
  process.exit(1);
}
const apply = process.argv.includes('--apply');

await initDb();
const db = await getDb();
console.log(`backfill-provider-ids: ${apply ? 'APPLY' : 'dry run'} (pass --apply to write)\n`);

const report = await backfillProviderIds(db, new TcgPriceLookupClient(db), { apply, log: console.log });

console.log(`\nmarkets needing ids: ${report.total}`);
console.log(`matched:             ${report.matched}${apply ? ` (applied: ${report.applied})` : ' (dry run — nothing written)'}`);
console.log(`unmatched:           ${report.unmatched.length}`);
for (const u of report.unmatched) console.log(`  - [${u.reason}] ${u.name} (${u.id})`);

await closeDb();
