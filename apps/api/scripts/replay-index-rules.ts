/**
 * Q-A4 report (2026-10-18 plan): replay the index history under the OLD rule and under rules v3, on repaired prices,
 * for each buffer setting — services/index-rules-replay.ts. READ-ONLY on the source: it only SELECTs from it; the
 * featured-history seed, the wrong-printing repair and both replays run on an in-memory scratch database.
 *
 *   npx tsx scripts/replay-index-rules.ts --ro \
 *     --base ~/gachadex-backfill-plan.json --snapshot ~/gachadex-featured-snapshot-2026-10-18.json \
 *     --changes-at pokemon=2026-10-17T08:35:42Z,onepiece=2026-10-17T08:37:30Z,mtg=2026-10-17T09:10:49Z \
 *     [--stay 110,120] [--out report.json]
 *
 * --ro: the read-only role (~/.gachadex_ro_url) over pinned TLS (~/.gachadex_ro_ca.pem, as .ro-query.mjs);
 * else SOURCE_DATABASE_URL. --base / --snapshot / --changes-at: the featured history, exactly as for
 * scripts/seed-featured-events.ts (the source has no featured_events before P2 deploys).
 */
import fs from 'node:fs';
import pg from 'pg';

// the scratch database — set before the app modules read config. A disk-backed scratch dir (REPLAY_PGLITE_DIR, an empty
// directory you delete after) holds a full copy where the in-memory one runs out of WASM memory.
process.env.PGLITE_DIR = process.env.REPLAY_PGLITE_DIR || 'memory://';
process.env.DATABASE_URL = '';

const argv = process.argv.slice(2);
const values = (flag: string) => argv.flatMap((a, i) => (a === flag && argv[i + 1] ? [argv[i + 1]] : []));
const value = (flag: string): string | undefined => values(flag)[0];
const basePath = value('--base');
const snapshotPaths = values('--snapshot');
if (!basePath || !snapshotPaths.length) {
  console.error('usage: replay-index-rules.ts (--ro | SOURCE_DATABASE_URL=…) --base <plan.json> --snapshot <snap.json> [--changes-at game=ISO,…] [--stay 110,120] [--out file]');
  process.exit(1);
}
const stays = (value('--stay') ?? '110,120').split(',').map(Number).filter((n) => n >= 100);
const OUTAGE: [Date, Date] = [new Date('2026-09-24T00:00:00Z'), new Date('2026-10-02T00:00:00Z')]; // 24 Sep – 1 Oct

const { getDb, closeDb } = await import('../src/db/client.ts');
const { initDb } = await import('../src/db/init.ts');
const { config } = await import('../src/config.ts');
const { planFeaturedSeed, applyFeaturedSeed, BASE_AT } = await import('../src/services/featured-history.ts');
const { planPrintingRepair, applyPrintingRepair } = await import('../src/services/printing-repair.ts');
const { copyForReplay, backfillGradedHistory, replayOld, replayV3, compareReplays } = await import('../src/services/index-rules-replay.ts');

// --- source (read-only) ---
let src: pg.Client;
if (argv.includes('--ro')) {
  const url = fs.readFileSync(`${process.env.HOME}/.gachadex_ro_url`, 'utf8').trim();
  const ca = fs.readFileSync(`${process.env.HOME}/.gachadex_ro_ca.pem`, 'utf8');
  src = new pg.Client({ connectionString: url, ssl: { ca, rejectUnauthorized: true, checkServerIdentity: () => undefined }, connectionTimeoutMillis: 15000 });
} else {
  if (!process.env.SOURCE_DATABASE_URL) throw new Error('set SOURCE_DATABASE_URL or pass --ro');
  src = new pg.Client({ connectionString: process.env.SOURCE_DATABASE_URL });
}
await src.connect();
await src.query('SET default_transaction_read_only = on'); // belt and braces: this session can't write

// --- featured history inputs (the same files and dating as the seed script) ---
const plan = JSON.parse(fs.readFileSync(basePath, 'utf8')) as { rows: { symbol: string }[]; misses: { symbol: string }[] };
const baseSymbols = [...new Set([...plan.rows, ...plan.misses].map((r) => r.symbol))];
const changesAt: Record<string, Date> = {};
for (const pair of (value('--changes-at') ?? '').split(',').filter(Boolean)) {
  const [game, iso] = pair.split('=');
  const d = new Date(iso);
  if (!['pokemon', 'onepiece', 'mtg'].includes(game) || Number.isNaN(d.getTime())) throw new Error(`bad --changes-at entry "${pair}" (want game=ISO-time)`);
  changesAt[game] = d;
}
const snapshots = snapshotPaths.map((p) => {
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  return (Array.isArray(raw) ? raw[0] : raw) as { taken_at: string; markets: { id: string; featured: boolean }[] };
});
const everFeatured = new Set<string>([
  ...(await src.query<{ id: string }>(`SELECT id FROM markets WHERE kind = 'card' AND (featured OR symbol = ANY($1))`, [baseSymbols])).rows.map((r) => r.id),
  ...snapshots.flatMap((s) => s.markets.filter((m) => m.featured).map((m) => m.id)),
]);

// --- scratch ---
await initDb();
const db = await getDb();
const t0 = Date.now();
const copyStartedAt = new Date();
const copied = await copyForReplay(src, db, [...everFeatured]);
// the repair is PLANNED on the source (read-only, as the P4 dry run) and applied to the copy, whose prints keep their
// ids — the planner's one big payload read is too much for the embedded scratch database. Planned up to the copy's
// start, so a pass landing mid-copy can't add a print the copy lacks.
const repair = await planPrintingRepair(src, { clampBps: 2500, until: copyStartedAt });
await src.end();
console.log(`copied (read-only): ${JSON.stringify(copied)} in ${Math.round((Date.now() - t0) / 1000)} s`);

const ids = new Map((await db.query<{ id: string; symbol: string }>(`SELECT id, symbol FROM markets WHERE kind = 'card'`)).rows.map((r) => [r.symbol, r.id]));
const seed = await planFeaturedSeed(db, [
  { label: 'base-2026-10-16', at: BASE_AT, marketIds: new Set(baseSymbols.map((s) => ids.get(s)).filter((x): x is string => !!x)) },
  ...snapshots.map((s, i) => ({
    label: `snapshot-${s.taken_at.slice(0, 10)}`, at: new Date(s.taken_at),
    marketIds: new Set(s.markets.filter((m) => m.featured).map((m) => m.id)), changesAt: i === 0 ? changesAt : undefined,
  })),
]);
await applyFeaturedSeed(db, seed);
console.log(`featured history seeded: ${seed.events.length} events + ${seed.reconcile.length} reconcile`);

// only the copied (ever-featured) markets — the index history — get the repair; the rest aren't in the copy
const inCopy = new Set(
  (await db.query<{ id: string }>(`SELECT id::text FROM oracle_prices WHERE id = ANY($1::bigint[])`, [[...repair.ladderDrops, ...repair.rewrites.map((r) => r.printId)]])).rows.map((r) => r.id),
);
const scoped = {
  ...repair,
  rewrites: repair.rewrites.filter((r) => everFeatured.has(r.marketId) && inCopy.has(r.printId)),
  ladderDrops: repair.ladderDrops.filter((id) => inCopy.has(id)),
  markRepairs: repair.markRepairs.filter((m) => everFeatured.has(m.marketId)),
  byMarket: repair.byMarket.filter((m) => everFeatured.has(m.marketId)),
};
await applyPrintingRepair(db, scoped);
console.log(`wrong-printing repair applied to the scratch copy: ${scoped.rewrites.length} of ${repair.rewrites.length} planned prints (${scoped.byMarket.length} index-relevant markets)`);

const gradedRows = await backfillGradedHistory(db);
console.log(`PSA-10 history before tracking began, written from each print: ${gradedRows} rows`);

const opts = {
  freshMs: config.indexFreshMs, outlierFactor: config.indexOutlierFactor, gradedConstituents: config.gradedConstituents,
  sealedMin: config.sealedIndexMinConstituents, sealedEnabled: config.sealedIndexEnabled, gapFill: false,
};
const old = await replayOld(db, opts);
console.log(`old rule: ${old.series.length} series`);
const report: Record<string, unknown> = { generatedAt: new Date().toISOString(), copied, repairPrints: scoped.rewrites.length, outage: OUTAGE.map((d) => d.toISOString()), runs: {} };
for (const stay of stays) {
  const v3 = await replayV3(db, opts, old, stay, console.log);
  const cmp = compareReplays(old, v3, OUTAGE);
  (report.runs as Record<string, unknown>)[String(stay)] = { comparison: cmp, changes: v3.changes };
  console.log(`\n== rules v3, stay ${stay}% ==`);
  for (const c of cmp) {
    console.log(`${c.symbol.padEnd(26)} end old ${c.oldEnd.toFixed(2).padStart(10)} new ${c.newEnd.toFixed(2).padStart(10)} (${c.endDiffPct >= 0 ? '+' : ''}${c.endDiffPct.toFixed(2)}%)  max gap ${c.maxDiffPct.toFixed(2)}%  turnover ${c.turnoverOld} → ${c.turnoverNew}  outage passes ${c.outagePoints}`);
  }
  for (const ch of v3.changes) {
    console.log(`  ${ch.basket.padEnd(18)} ${ch.changeDate}  joined ${ch.joined} left ${JSON.stringify(ch.left)}  (announced +${ch.announced.adds} −${ch.announced.removes})  applied ${ch.appliedAt?.slice(0, 16) ?? '—'}`);
  }
}
const out = value('--out');
if (out) fs.writeFileSync(out, JSON.stringify(report, null, 2));
await closeDb();
