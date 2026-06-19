/**
 * Derive the proposed trading universe from price_index and report the change vs the current featured
 * markets (docs/price-index-universe-rederivation.md). DRY-RUN by default — reads only. The --apply
 * re-curation lands in a later step (applyUniverse).
 *
 *   DATABASE_URL=<prod> npx tsx scripts/derive-universe.ts [--top-n 250] [--jpy-floor 100]
 */
import { getDb, closeDb } from '../src/db/client.ts';
import { initDb } from '../src/db/init.ts';
import { deriveUniverse, UNIVERSE_TOP_N, JPY_FLOOR_USD } from '../src/services/universe.ts';

const arg = (flag: string, def: number): number => {
  const i = process.argv.indexOf(flag);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : def;
};
const topN = arg('--top-n', UNIVERSE_TOP_N);
const jpyFloor = arg('--jpy-floor', JPY_FLOOR_USD);

await initDb();
const db = await getDb();

const u = await deriveUniverse(db, { topN, jpyFloorUsd: jpyFloor });
console.log(`\nDerived universe (top-${topN}/game EN + JPY>$${jpyFloor}):`);
for (const [game, b] of Object.entries(u.summary.byGame)) console.log(`  ${game.padEnd(9)} | EN ${b.enTop} | JPY ${b.jpyFloor}`);
console.log(`  TOTAL ${u.summary.total} markets · ${u.summary.requiresScrydex} require Scrydex (hidden until ORACLE_PRIMARY=scrydex)`);

// churn vs the current featured set
const derived = new Set(u.markets.map((m) => String(m.tcgplayerId)));
const cur = (
  await db.query<{ tid: string }>(
    `SELECT tcgplayer_id::text AS tid FROM markets WHERE kind='card' AND featured AND status<>'delisted' AND tcgplayer_id IS NOT NULL`,
  )
).rows.map((r) => r.tid);
const curSet = new Set(cur);
const stay = cur.filter((t) => derived.has(t)).length;
const drop = cur.filter((t) => !derived.has(t)).length;
const enter = [...derived].filter((t) => !curSet.has(t)).length;
console.log(`\nChurn vs current featured (${cur.length}):  stay ${stay} · drop ${drop} · enter ${enter}`);

// of the drop-outs, how many hold open positions (must stay close-only — never delete)
const dropTids = cur.filter((t) => !derived.has(t));
if (dropTids.length) {
  const oi = await db.query<{ n: string }>(
    `SELECT count(DISTINCT m.id) n FROM markets m JOIN positions p ON p.market_id = m.id AND (p.status='open' OR p.closed_at IS NULL)
       WHERE m.kind='card' AND m.featured AND m.tcgplayer_id::text = ANY($1)`,
    [dropTids],
  );
  console.log(`  drop-outs holding open positions (close-only, not deleted): ${oi.rows[0].n}`);
}
console.log('\n(dry-run — no markets changed)');
await closeDb();
