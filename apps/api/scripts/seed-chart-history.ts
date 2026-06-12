/**
 * One-time ops script: seed every tracked card market's chart with the provider's 1y daily price
 * history (chart_seed table; pre-first-mark days only ever render). Safe to interrupt + re-run —
 * already-seeded markets are skipped.
 *
 *   DATABASE_URL=<prod-postgres> TCGPRICELOOKUP_API_KEY=<key> npx tsx scripts/seed-chart-history.ts          # dry run (count only)
 *   DATABASE_URL=<prod-postgres> TCGPRICELOOKUP_API_KEY=<key> npx tsx scripts/seed-chart-history.ts --apply  # fetch + write
 *
 * One history request per market: ~750 markets at the provider's 1 req/s ≈ 14 minutes.
 */
import { randomUUID } from 'node:crypto';
import { config } from '../src/config.ts';
import { getDb, closeDb } from '../src/db/client.ts';
import { initDb } from '../src/db/init.ts';
import { TcgPriceLookupClient } from '../src/services/providers/tcgpricelookup.ts';
import { countMissingHistory, seedMissingHistory } from '../src/services/providers/history.ts';
import { tryAcquireLease, releaseLease } from '../src/services/lease.ts';

if (!config.tcgpricelookupApiKey) {
  console.error('TCGPRICELOOKUP_API_KEY is not set');
  process.exit(1);
}
const apply = process.argv.includes('--apply');

await initDb();
const db = await getDb();

if (!apply) {
  const n = await countMissingHistory(db);
  console.log(`seed-chart-history: dry run — ${n} markets need seeding (pass --apply to fetch + write)`);
  await closeDb();
  process.exit(0);
}

// The server's hourly sweep holds this same lease — without it, both would fetch every unseeded
// market and double-spend the provider budget (writes are conflict-safe either way).
const HOLDER = randomUUID();
if (!(await tryAcquireLease(db, 'chart-seed', HOLDER, 60 * 60_000))) {
  console.error('seed-chart-history: the server sweep holds the chart-seed lease — let it finish (or retry in an hour)');
  await closeDb();
  process.exit(1);
}

console.log('seed-chart-history: APPLY\n');
try {
  const report = await seedMissingHistory(db, new TcgPriceLookupClient(db), { log: console.log });
  console.log(`\nmarkets needing seed: ${report.markets}`);
  console.log(`seeded:               ${report.seeded} (${report.points} points)`);
  console.log(`failed:               ${report.failed}${report.failed > 0 ? ' (re-run to retry just these)' : ''}`);
  process.exitCode = report.failed > 0 && report.seeded === 0 ? 1 : 0;
} finally {
  await releaseLease(db, 'chart-seed', HOLDER).catch(() => {});
  await closeDb();
}
