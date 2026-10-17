/**
 * Reject bad card prints (services/price-cleanup.ts — rules P placeholder-replay + E reverted-excursion; rule S
 * persistent shifts are reported, never auto-rejected) and replay the card-chart marks as if every rejected print had
 * never landed (the mark guard re-applied; marks under a position and the live mark kept); positions open during a
 * rejected window are listed for review. Dry-run by default.
 *
 *   DATABASE_URL=<prod> npx tsx scripts/clean-bad-prints.ts                       # report only
 *   DATABASE_URL=<prod> npx tsx scripts/clean-bad-prints.ts --out cleanup.json    # + write the full plan as JSON
 *   DATABASE_URL=<prod> npx tsx scripts/clean-bad-prints.ts --apply               # reject + reset (prints the run id)
 *     --reject 123,456   also reject these print ids (rule M — a bad print no rule catches)
 * Undo: npx tsx scripts/revert-history-repair.ts <runId>
 */
import fs from 'node:fs';
import { getDb, closeDb } from '../src/db/client.ts';
import { initDb } from '../src/db/init.ts';
import { planPriceCleanup, applyPriceCleanup } from '../src/services/price-cleanup.ts';
import { withIngestLease } from '../src/services/history-repair.ts';
import { loadMarkClampBps, getMarkClampBps } from '../src/services/marks.ts';

const apply = process.argv.includes('--apply');
const outIdx = process.argv.indexOf('--out');
const rejectIdx = process.argv.indexOf('--reject');
const rejectArg = rejectIdx >= 0 ? process.argv[rejectIdx + 1] ?? '' : null;
if (rejectArg != null && !/^\d+(,\d+)*$/.test(rejectArg)) {
  console.error(`--reject takes print ids, e.g. --reject 548282,548300 (got "${rejectArg}")`);
  process.exit(1);
}
const reject = rejectArg ? rejectArg.split(',').map((x) => BigInt(x).toString()) : [];
await initDb();
const db = await getDb();
await loadMarkClampBps(db); // the mark replay re-applies the live guard threshold
const plan = await planPriceCleanup(db, { reject, clampBps: getMarkClampBps() });
console.log(`clean-bad-prints: ${apply ? 'APPLY' : 'dry run'} — ${plan.rejected.length} prints to reject across ${plan.byMarket.length} markets`);
for (const m of plan.byMarket.slice(0, 60)) {
  console.log(`  [${m.rule}] ${m.symbol.padEnd(44)} ${String(m.prints).padStart(4)} prints  ${m.firstAt.toISOString().slice(0, 10)}→${m.lastAt.toISOString().slice(0, 10)}  printed $${m.printedUsd} vs $${m.referenceUsd ?? '—'}  ${m.name}`);
}
console.log(`\npersistent ≥5× shifts for manual review (NOT rejected): ${plan.review.length}`);
for (const r of plan.review.slice(0, 40)) console.log(`  ${r.symbol.padEnd(44)} ${r.at.toISOString().slice(0, 10)} $${r.fromUsd} → $${r.toUsd}  ${r.name}`);
console.log(`\npositions open during a rejected window: ${plan.exposures.length}`);
for (const e of plan.exposures) console.log(`  ${e.symbol} position ${e.positionId} (${e.side}, ${e.status}) ${e.openedAt.toISOString()} → ${e.closedAt?.toISOString() ?? 'open'}`);
const k = plan.marksKept;
console.log(`\nchart marks to replay as if the rejected prints never landed: ${plan.markRepairs.length} across ${new Set(plan.markRepairs.map((m) => m.marketId)).size} cards`);
console.log(`  kept as-is: ${k.position} (a position was open), ${k.live} (still catching up at the live mark), ${k.unexplained} (a clamp the guard formula doesn't reproduce), ${k.noReference} (no accepted price to use)`);
if (outIdx >= 0) fs.writeFileSync(process.argv[outIdx + 1], JSON.stringify(plan, null, 2));
if (apply) {
  const r = await withIngestLease(db, () => applyPriceCleanup(db, plan));
  console.log(`\nrejected ${r.rejected} prints, reset ${r.marksReset} marks — run id: ${r.runId}`);
}
await closeDb();
