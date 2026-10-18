/**
 * Repair prices taken from the wrong card printing (services/printing-repair.ts): rewrite the affected Scrydex-anchored
 * prints in place to our printing's TCGplayer price from the same record, drop the wrong printing's PSA-10, and replay
 * the card-chart marks. Dry-run by default.
 *
 *   DATABASE_URL=<prod> npx tsx scripts/repair-wrong-printings.ts                     # report only
 *   DATABASE_URL=<prod> npx tsx scripts/repair-wrong-printings.ts --out repair.json   # + the full plan as JSON
 *   DATABASE_URL=<prod> npx tsx scripts/repair-wrong-printings.ts --apply             # rewrite (prints the run id)
 * Undo: npx tsx scripts/revert-history-repair.ts <runId>
 */
import fs from 'node:fs';
import { getDb, closeDb } from '../src/db/client.ts';
import { initDb } from '../src/db/init.ts';
import { planPrintingRepair, applyPrintingRepair } from '../src/services/printing-repair.ts';
import { withIngestLease } from '../src/services/history-repair.ts';
import { loadMarkClampBps, getMarkClampBps } from '../src/services/marks.ts';

const apply = process.argv.includes('--apply');
const outIdx = process.argv.indexOf('--out');
await initDb();
const db = await getDb();
await loadMarkClampBps(db); // the mark replay re-applies the live guard threshold
const run = async () => {
  const plan = await planPrintingRepair(db, { clampBps: getMarkClampBps() });
  console.log(`repair-wrong-printings: ${apply ? 'APPLY' : 'dry run'} — ${plan.rewrites.length} prints across ${plan.byMarket.length} markets`);
  for (const m of plan.byMarket) {
    console.log(
      `  [${m.rules}] ${m.symbol.padEnd(46)} ${String(m.prints).padStart(4)} prints  ${m.firstAt.toISOString().slice(0, 10)}→${m.lastAt.toISOString().slice(0, 10)}  ` +
        `typical gap ${m.typicalGap}×  ${m.variant ?? '—'} priced as ${m.oldPick ?? '?'}  ${m.name}`,
    );
  }
  const k = plan.marksKept;
  console.log(`\nother pre-fix prints of those markets whose wrong-printing PSA-10 is dropped (value kept): ${plan.ladderDrops.length}`);
  console.log(`\nchart marks to replay: ${plan.markRepairs.length} across ${new Set(plan.markRepairs.map((m) => m.marketId)).size} cards`);
  console.log(`  kept as-is: ${k.position} (a position was open), ${k.live} (not rejoined before the live mark), ${k.unexplained} (a clamp the guard formula doesn't reproduce)`);
  if (outIdx >= 0) fs.writeFileSync(process.argv[outIdx + 1], JSON.stringify(plan, null, 2));
  // A rule-B print in the last 12 h means the live wrong-printing guard (7548cc4) isn't deployed yet: live passes would
  // keep writing the wrong price next to the repaired history. Deploy first (or --force).
  const recentB = plan.rewrites.filter((r) => r.rule === 'B' && Date.now() - r.at.getTime() < 12 * 3_600_000);
  if (apply && recentB.length && !process.argv.includes('--force')) {
    console.error(`\nrefusing to apply: ${recentB.length} wrong-printing prints in the last 12 h — deploy the live guard (7548cc4) first, or pass --force`);
    return;
  }
  if (apply) {
    const r = await applyPrintingRepair(db, plan);
    console.log(`\nrewrote ${r.rewritten} prints, reset ${r.marksReset} marks — run id: ${r.runId}`);
  }
};
// apply holds the ingest lease so no live pass lands between plan and apply
await (apply ? withIngestLease(db, run) : run());
await closeDb();
