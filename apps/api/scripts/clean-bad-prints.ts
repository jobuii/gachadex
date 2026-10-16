/**
 * Reject bad card prints (services/price-cleanup.ts — rules P placeholder-replay + E reverted-excursion; rule S
 * persistent shifts are reported, never auto-rejected). Card marks are NOT touched (they're the trading record);
 * positions that were open during a rejected window are listed for review. Dry-run by default.
 *
 *   DATABASE_URL=<prod> npx tsx scripts/clean-bad-prints.ts                       # report only
 *   DATABASE_URL=<prod> npx tsx scripts/clean-bad-prints.ts --out cleanup.json    # + write the full plan as JSON
 *   DATABASE_URL=<prod> npx tsx scripts/clean-bad-prints.ts --apply               # reject them (prints the run id)
 * Undo: npx tsx scripts/revert-history-repair.ts <runId>
 */
import fs from 'node:fs';
import { getDb, closeDb } from '../src/db/client.ts';
import { initDb } from '../src/db/init.ts';
import { planPriceCleanup, applyPriceCleanup } from '../src/services/price-cleanup.ts';
import { withIngestLease } from '../src/services/history-repair.ts';

const apply = process.argv.includes('--apply');
const outIdx = process.argv.indexOf('--out');
await initDb();
const db = await getDb();
const plan = await planPriceCleanup(db);
console.log(`clean-bad-prints: ${apply ? 'APPLY' : 'dry run'} — ${plan.rejected.length} prints to reject across ${plan.byMarket.length} markets`);
for (const m of plan.byMarket.slice(0, 60)) {
  console.log(`  [${m.rule}] ${m.symbol.padEnd(44)} ${String(m.prints).padStart(4)} prints  ${m.firstAt.toISOString().slice(0, 10)}→${m.lastAt.toISOString().slice(0, 10)}  printed $${m.printedUsd} vs $${m.referenceUsd ?? '—'}  ${m.name}`);
}
console.log(`\npersistent ≥5× shifts for manual review (NOT rejected): ${plan.review.length}`);
for (const r of plan.review.slice(0, 40)) console.log(`  ${r.symbol.padEnd(44)} ${r.at.toISOString().slice(0, 10)} $${r.fromUsd} → $${r.toUsd}  ${r.name}`);
console.log(`\npositions open during a rejected window: ${plan.exposures.length}`);
for (const e of plan.exposures) console.log(`  ${e.symbol} position ${e.positionId} (${e.side}, ${e.status}) ${e.openedAt.toISOString()} → ${e.closedAt?.toISOString() ?? 'open'}`);
if (outIdx >= 0) fs.writeFileSync(process.argv[outIdx + 1], JSON.stringify(plan, null, 2));
if (apply) {
  const r = await withIngestLease(db, () => applyPriceCleanup(db, plan));
  console.log(`\nrejected ${r.rejected} prints — run id: ${r.runId}`);
}
await closeDb();
