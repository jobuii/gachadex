/**
 * Ops script (P4): crawl a game's tcgpricelookup catalog and rebalance its FEATURED top-N (the index
 * constituents). Resumable; dry-run by default.
 *
 *   DATABASE_URL=<db> TCGPRICELOOKUP_API_KEY=<key> npx tsx scripts/discover-featured.ts <game>            # dry run
 *   DATABASE_URL=<db> TCGPRICELOOKUP_API_KEY=<key> npx tsx scripts/discover-featured.ts <game> --apply    # rebalance
 *
 * Flags: --apply (write), --fresh (discard a previous crawl checkpoint), --top N (default 250),
 * --min-usd X (default 10). A full crawl is ~9 min/game at the provider's 1 req/s; interrupted runs
 * resume from the checkpoint. SEQUENCING (plan P5): run pokemon only at cutover — pre-cutover the live
 * pokemontcg feed re-stamps its own featured set every pass and the two would fight. OP/MTG: any time.
 */
import { config } from '../src/config.ts';
import { getDb, closeDb } from '../src/db/client.ts';
import { initDb } from '../src/db/init.ts';
import { TcgPriceLookupClient } from '../src/services/providers/tcgpricelookup.ts';
import { discoverGame } from '../src/services/providers/discovery.ts';

const game = process.argv[2];
if (!['pokemon', 'onepiece', 'mtg'].includes(game ?? '')) {
  console.error('usage: discover-featured.ts <pokemon|onepiece|mtg> [--apply] [--fresh] [--force] [--top N] [--min-usd X]');
  process.exit(1);
}
if (!config.tcgpricelookupApiKey) {
  console.error('TCGPRICELOOKUP_API_KEY is not set');
  process.exit(1);
}
const flag = (name: string) => process.argv.includes(name);
const num = (name: string, fallback: number) => {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
};

await initDb();
const db = await getDb();
const apply = flag('--apply');
console.log(`discover-featured: ${game} ${apply ? 'APPLY' : 'dry run'} (pass --apply to rebalance)\n`);

const report = await discoverGame(db, new TcgPriceLookupClient(db), game, {
  topN: num('--top', 250),
  minPriceUsd: num('--min-usd', 10),
  apply,
  fresh: flag('--fresh'),
  force: flag('--force'), // bypass the pokemon cutover-sequencing guard (cutover window only)
  log: console.log,
});

console.log(`\nscanned: ${report.scanned} (resumed from offset ${report.resumedFromOffset})`);
console.log(`kept >= threshold: ${report.kept}`);
console.log(`featured top-${report.top.length}${report.applied ? ' (APPLIED)' : ' (dry run — nothing written)'}`);
for (const c of report.top.slice(0, 10)) console.log(`  $${c.price.toFixed(2)}  ${c.id}`);
if (report.top.length > 10) console.log(`  … ${report.top.length - 10} more`);

await closeDb();
