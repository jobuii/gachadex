/**
 * Undo one history-repair run (clean-bad-prints / backfill-gap-prices / rebuild-index-history) by its run id —
 * restores rewritten values, re-accepts rejected prints, deletes inserted rows. Revert in REVERSE order of apply.
 *
 *   DATABASE_URL=<prod> npx tsx scripts/revert-history-repair.ts <runId> [--force]
 * Refuses (without --force) to revert a run while a LATER repair run touched the same markets (revert newest-first),
 * or a rebuild once a live oracle pass has chained off it.
 */
import { getDb, closeDb } from '../src/db/client.ts';
import { initDb } from '../src/db/init.ts';
import { revertHistoryRepair, withIngestLease } from '../src/services/history-repair.ts';

const runId = process.argv[2];
if (!runId) {
  console.error('usage: revert-history-repair.ts <runId>');
  process.exit(1);
}
await initDb();
const db = await getDb();
console.log(await withIngestLease(db, () => revertHistoryRepair(db, runId, { force: process.argv.includes('--force') })));
await closeDb();
