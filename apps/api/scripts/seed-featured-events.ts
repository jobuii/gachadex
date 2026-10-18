/**
 * Seed featured_events with the featured history from before the trigger existed (services/featured-history.ts).
 * Dry-run by default.
 *
 *   DATABASE_URL=<prod> npx tsx scripts/seed-featured-events.ts \
 *     --base ~/gachadex-backfill-plan.json \
 *     --snapshot ~/gachadex-featured-snapshot-2026-10-18.json \
 *     --changes-at pokemon=2026-10-17T08:35:42Z,onepiece=2026-10-17T08:37:30Z,mtg=2026-10-17T09:10:49Z
 *   … --apply            write the events (one transaction)
 *   … --replace          redo a previous seed (removes the earlier 'seed:' rows first)
 *
 * --base: the 16-Oct backfill plan (its rows + misses name the 707 markets that were featured). --snapshot (repeatable,
 * oldest first): a read-only dump of markets {id, featured} with taken_at. --changes-at dates the flips into the FIRST
 * snapshot per game (a later snapshot's flips are dated at its own taken_at).
 */
import fs from 'node:fs';
import { getDb, closeDb } from '../src/db/client.ts';
import { initDb } from '../src/db/init.ts';
import { GAMES } from '@pokex/shared-types';
import { planFeaturedSeed, applyFeaturedSeed, BASE_AT, type FeaturedList } from '../src/services/featured-history.ts';

const argv = process.argv.slice(2);
const values = (flag: string): string[] => argv.flatMap((a, i) => (a === flag && argv[i + 1] ? [argv[i + 1]] : []));
const apply = argv.includes('--apply');
const replace = argv.includes('--replace');
const basePath = values('--base')[0];
const snapshotPaths = values('--snapshot');
if (!basePath || !snapshotPaths.length) {
  console.error('usage: seed-featured-events.ts --base <backfill-plan.json> --snapshot <snapshot.json> [--snapshot …] [--changes-at game=ISO,…] [--apply] [--replace]');
  process.exit(1);
}
const changesAt: Record<string, Date> = {};
for (const pair of (values('--changes-at')[0] ?? '').split(',').filter(Boolean)) {
  const [game, iso] = pair.split('=');
  const d = new Date(iso);
  if (!(GAMES as readonly string[]).includes(game) || Number.isNaN(d.getTime())) throw new Error(`bad --changes-at entry "${pair}" (want game=ISO-time, game one of ${GAMES.join('/')})`);
  changesAt[game] = d;
}

await initDb();
const db = await getDb();

// The base list: the markets the 16-Oct backfill planned for (rows + misses) — resolved to ids by symbol.
const plan = JSON.parse(fs.readFileSync(basePath, 'utf8')) as { rows: { symbol: string }[]; misses: { symbol: string }[] };
const baseSymbols = [...new Set([...plan.rows, ...plan.misses].map((r) => r.symbol))];
const ids = await db.query<{ id: string; symbol: string }>(`SELECT id, symbol FROM markets WHERE symbol = ANY($1)`, [baseSymbols]);
const lists: FeaturedList[] = [{ label: 'base-2026-10-16', at: BASE_AT, marketIds: new Set(ids.rows.map((r) => r.id)) }];
console.log(`base: ${baseSymbols.length} symbols in the plan, ${ids.rows.length} found as markets`);

snapshotPaths.forEach((p, i) => {
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const snap = (Array.isArray(raw) ? raw[0] : raw) as { taken_at: string; markets: { id: string; featured: boolean }[] };
  const at = new Date(snap.taken_at);
  const featured = new Set(snap.markets.filter((m) => m.featured).map((m) => m.id));
  lists.push({ label: `snapshot-${at.toISOString().slice(0, 10)}`, at, marketIds: featured, changesAt: i === 0 ? changesAt : undefined });
  console.log(`snapshot ${p}: taken ${at.toISOString()}, ${featured.size} featured`);
});

const seed = await planFeaturedSeed(db, lists); // reconcile dated at the trigger's install (its first own event)
console.log(`\nseed-featured-events: ${apply ? 'APPLY' : 'dry run'} — ${seed.events.length} seed events + ${seed.reconcile.length} reconcile`);
for (const [game, t] of Object.entries(seed.byGame)) {
  console.log(`  ${game.padEnd(9)} base ${String(t.base).padStart(4)}   on ${String(t.on).padStart(4)}   off ${String(t.off).padStart(4)}   reconcile ${t.reconcile}`);
}
if (seed.unknownMarketIds.length) console.log(`  ${seed.unknownMarketIds.length} listed market ids are not card markets here (skipped)`);
if (apply) {
  const n = await applyFeaturedSeed(db, seed, { replace });
  console.log(`\nwrote ${n} featured_events rows`);
}
await closeDb();
