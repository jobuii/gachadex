/**
 * Fill card prices on UTC days with NO oracle pass (services/price-backfill.ts) from the providers' daily history:
 * Scrydex price_history for Scrydex-matched cards, tcgpl /history for the rest. Calls the paid APIs (credits) —
 * run --probe first (2 calls) to confirm the response shapes. Dry-run by default; run the index rebuild after.
 *
 *   DATABASE_URL=<prod> SCRYDEX_API_KEY=… SCRYDEX_TEAM_ID=… TCGPRICELOOKUP_API_KEY=… npx tsx scripts/backfill-gap-prices.ts --probe
 *   … npx tsx scripts/backfill-gap-prices.ts --out plan.json            # plan: fetch + report + save (spends credits, writes nothing)
 *   … npx tsx scripts/backfill-gap-prices.ts --apply --plan plan.json   # write the SAVED plan (no provider calls; prints the run id)
 *   … npx tsx scripts/backfill-gap-prices.ts --apply                    # fetch + write in one go
 *     --days 2026-09-24,2026-09-25   override the gap days (default: every day with no pass)
 * Undo: npx tsx scripts/revert-history-repair.ts <runId>
 */
import fs from 'node:fs';
import { getDb, closeDb } from '../src/db/client.ts';
import { initDb } from '../src/db/init.ts';
import { missingPassDays } from '../src/services/index-rebuild.ts';
import { planBackfill, applyBackfill, serializeBackfillPlan, parseBackfillPlan } from '../src/services/price-backfill.ts';
import { getDefaultScrydexClient, scrydexSlug } from '../src/services/providers/scrydex.ts';
import { getDefaultClient } from '../src/services/providers/tcgpricelookup.ts';
import { getJpyUsd } from '../src/services/providers/fx.ts';

const apply = process.argv.includes('--apply');
const probe = process.argv.includes('--probe');
const daysIdx = process.argv.indexOf('--days');
const argAfter = (flag: string) => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : null);
const outPath = argAfter('--out');
const planPath = argAfter('--plan');
await initDb();
const db = await getDb();
const sx = getDefaultScrydexClient(db);
const tpl = getDefaultClient(db);
const days = planPath ? [] : daysIdx >= 0 ? process.argv[daysIdx + 1].split(',') : await missingPassDays(db);
if (!planPath) console.log(`gap days (no oracle pass): ${days.length ? days.join(', ') : 'none'}`);

if (probe) {
  const one = await db.query<{ game: string; scrydex_card_id: string | null; provider_card_id: string | null }>(
    `SELECT game, scrydex_card_id, provider_card_id FROM markets WHERE kind='card' AND featured AND scrydex_card_id IS NOT NULL AND game='pokemon' LIMIT 1`,
  );
  const two = await db.query<{ provider_card_id: string }>(
    `SELECT provider_card_id FROM markets WHERE kind='card' AND featured AND scrydex_card_id IS NULL AND provider_card_id IS NOT NULL LIMIT 1`,
  );
  const d = days[days.length - 1] ?? new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  if (one.rows[0]) {
    const h = await sx.getPriceHistory(scrydexSlug(one.rows[0].game)!, one.rows[0].scrydex_card_id!, d, d, 'discovery');
    console.log('\nScrydex price_history sample:', JSON.stringify(h, null, 1).slice(0, 3000));
  }
  if (two.rows[0]) {
    const h = await tpl.getCardHistory(two.rows[0].provider_card_id, '30d', 'discovery');
    console.log('\ntcgpl history sample (30d):', JSON.stringify(h.slice(0, 4), null, 1).slice(0, 3000), `\n… ${h.length} points in 30d (density check)`);
  }
  await closeDb();
  process.exit(0);
}

const plan = planPath
  ? parseBackfillPlan(fs.readFileSync(planPath, 'utf8'))
  : await planBackfill(
      db,
      {
        scrydexCards: (slug, ids) => sx.getCardsByIds(slug, ids, 'discovery'),
        scrydexHistory: (slug, id, a, b) => sx.getPriceHistory(slug, id, a, b, 'discovery'),
        tcgplHistory: (id) => tpl.getCardHistory(id, '1y', 'discovery'),
        fxJpyUsd: getJpyUsd,
      },
      days,
      console.log,
    );
if (planPath) console.log(`loaded saved plan ${planPath} — gap days ${plan.days.join(', ')} (no provider calls)`);
if (outPath) fs.writeFileSync(outPath, serializeBackfillPlan(plan));
const bySource = plan.rows.reduce<Record<string, number>>((a, r) => ((a[r.source] = (a[r.source] ?? 0) + 1), a), {});
console.log(`\nprints planned: ${plan.rows.length} ${JSON.stringify(bySource)}   misses: ${plan.misses.length}`);
console.log(`provider calls: ${JSON.stringify(plan.calls)}`);
for (const m of plan.misses.slice(0, 30)) console.log(`  miss ${m.symbol}: ${m.reason}`);
if (outPath) console.log(`\nplan saved to ${outPath} — review, then: --apply --plan ${outPath}`);
if (apply) {
  const r = await applyBackfill(db, plan);
  console.log(`\nwrote ${r.points} prints (+ a card mark each) — run id: ${r.runId}`);
}
await closeDb();
