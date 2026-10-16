/**
 * Recompute every index's full history with the current methodology (services/index-rebuild.ts). Run AFTER
 * clean-bad-prints and backfill-gap-prices. --apply holds the oracle-ingest lease for plan+apply and REFUSES while
 * any affected index has an open position (its live mark would jump) unless --allow-open-positions. Dry-run by default.
 *
 *   DATABASE_URL=<prod> npx tsx scripts/rebuild-index-history.ts                  # before/after report
 *   DATABASE_URL=<prod> npx tsx scripts/rebuild-index-history.ts --out plan.json  # + full per-point plan
 *   DATABASE_URL=<prod> npx tsx scripts/rebuild-index-history.ts --apply          # rewrite (prints the run id)
 *     --no-gap-fill            don't add points on days with no pass
 *     --allow-open-positions   apply even with open index positions (review the listed ones first)
 * Undo: npx tsx scripts/revert-history-repair.ts <runId>
 */
import fs from 'node:fs';
import { config } from '../src/config.ts';
import { getDb, closeDb } from '../src/db/client.ts';
import { initDb } from '../src/db/init.ts';
import { planIndexRebuild, applyIndexRebuild, summarizeRebuild, openIndexPositions } from '../src/services/index-rebuild.ts';
import { withIngestLease } from '../src/services/history-repair.ts';

const apply = process.argv.includes('--apply');
const allowOpenPositions = process.argv.includes('--allow-open-positions');
const outIdx = process.argv.indexOf('--out');
const opts = {
  freshMs: config.indexFreshMs,
  outlierFactor: config.indexOutlierFactor,
  gradedConstituents: config.gradedConstituents,
  sealedMin: config.sealedIndexMinConstituents,
  sealedEnabled: config.sealedIndexEnabled,
  gapFill: !process.argv.includes('--no-gap-fill'),
};
await initDb();
const db = await getDb();
// A dry run plans WITHOUT the ingest lease (it must never block a live pass); --apply plans + applies inside it, so
// no live pass lands in between.
const run = async () => {
  const p = await planIndexRebuild(db, opts);
  return { plan: p, report: apply ? await applyIndexRebuild(db, p, console.log, { allowOpenPositions }) : null };
};
const { plan, report } = apply ? await withIngestLease(db, run) : await run();
console.table(summarizeRebuild(plan));
const open = await openIndexPositions(db, plan);
console.log(`\nopen positions on affected indices: ${open.length}${open.length ? ' — their LIVE mark moves to the rebuilt level on apply (needs --allow-open-positions)' : ''}`);
for (const p of open) console.log(`  ${p.symbol} ${p.side} ${p.qty_e6} (opened ${p.opened_at.toISOString()}) position ${p.id}`);
if (outIdx >= 0) fs.writeFileSync(process.argv[outIdx + 1], JSON.stringify(plan, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 1));
if (report) console.log(`\napplied — run id: ${report.runId}`, report);
else console.log('\ndry run — nothing written (pass --apply)');
await closeDb();
