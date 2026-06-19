/**
 * Derive the trading universe from price_index and re-curate `markets` to it
 * (docs/price-index-universe-rederivation.md). DRY-RUN by default (reads only); --apply writes.
 *
 *   # dry-run (no keys needed):
 *   DATABASE_URL=<prod> npx tsx scripts/derive-universe.ts [--top-n 250] [--jpy-floor 100]
 *   # apply (creates entrant markets → needs provider keys to fetch display/images):
 *   DATABASE_URL=<prod> SCRYDEX_API_KEY=.. SCRYDEX_TEAM_ID=.. TCGPRICELOOKUP_API_KEY=.. \
 *     npx tsx scripts/derive-universe.ts --apply
 */
import { config } from '../src/config.ts';
import { getDb, closeDb } from '../src/db/client.ts';
import { initDb } from '../src/db/init.ts';
import { deriveUniverse, applyUniverse, UNIVERSE_TOP_N, JPY_FLOOR_USD } from '../src/services/universe.ts';

const arg = (flag: string, def: number): number => {
  const i = process.argv.indexOf(flag);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : def;
};
const topN = arg('--top-n', UNIVERSE_TOP_N);
const jpyFloor = arg('--jpy-floor', JPY_FLOOR_USD);
const doApply = process.argv.includes('--apply');

if (doApply && (!config.scrydexApiKey || !config.scrydexTeamId || !config.tcgpricelookupApiKey)) {
  console.error('--apply creates entrant markets and needs SCRYDEX_API_KEY + SCRYDEX_TEAM_ID + TCGPRICELOOKUP_API_KEY (to fetch display/images)');
  process.exit(1);
}

await initDb();
const db = await getDb();

const u = await deriveUniverse(db, { topN, jpyFloorUsd: jpyFloor });
console.log(`\nDerived universe (top-${topN}/game EN + JPY>$${jpyFloor}):`);
for (const [game, b] of Object.entries(u.summary.byGame)) console.log(`  ${game.padEnd(9)} | EN ${b.enTop} | JPY ${b.jpyFloor}`);
console.log(`  TOTAL ${u.summary.total} · ${u.summary.requiresScrydex} require Scrydex (hidden until ORACLE_PRIMARY=scrydex)`);

// drop-outs holding open positions (must stay close-only) — a hard safety gate before applying
const oi = await db.query<{ n: string }>(
  `WITH derived AS (SELECT unnest($1::bigint[]) AS tid)
   SELECT count(DISTINCT m.id) n FROM markets m JOIN positions p ON p.market_id=m.id AND (p.status='open' OR p.closed_at IS NULL)
    WHERE m.kind='card' AND m.featured AND m.tcgplayer_id IS NOT NULL AND m.tcgplayer_id NOT IN (SELECT tid FROM derived)`,
  [u.markets.map((m) => m.tcgplayerId)],
);
console.log(`  drop-outs holding open positions: ${oi.rows[0].n} (kept close-only — never deleted)`);

const plan = await applyUniverse(db, u, { apply: doApply, log: (m) => console.log('  ' + m) });
console.log(`\n${doApply ? 'APPLIED' : 'PLAN (dry-run)'}: create ${plan.toCreate} · re-feature ${plan.toUpdate} · un-feature ${plan.toUnfeature}`);
if (doApply) console.log(`  result: created ${plan.created} · updated ${plan.updated} · unfeatured ${plan.unfeatured} · fetch failures ${plan.fetchFailures}`);
else console.log('  (dry-run — no markets changed; re-run with --apply)');
await closeDb();
