/**
 * Seed featured_events with the featured history that existed before the trigger did (2026-10-18 plan P2).
 *
 * Inputs are point-in-time lists of featured markets, oldest first:
 *  - the base list: the earliest known featured set, held "since the start" (it is dated BASE_AT). For prod this is
 *    the 707 markets of the 16-Oct backfill plan — the same set the 17-Oct history rebuild assumed for all history;
 *  - snapshots: later lists (e.g. ~/gachadex-featured-snapshot-2026-10-18.json). Each differs from the one before by
 *    discovery runs; those flips are dated `changesAt[game]` when known (the 17-Oct run flipped Pokémon 08:35,
 *    One Piece 08:37, MTG 09:10 UTC), else the snapshot's own time.
 * Then a reconcile step over EVERY card market: wherever seed history + the trigger's own events end in a state that
 * differs from the market's flag NOW (a flip between the last snapshot and the trigger's install), one 'seed:reconcile'
 * event fixes it, dated at the trigger's install (its first own event) — the latest moment such a flip can have
 * happened unrecorded. A market featured now with no events at all gets one too, so it isn't featured "forever".
 * Seed rows carry a 'seed:' source; a second run refuses unless told to replace them.
 */
import type { Db, Queryer } from '../db/client.ts';

export const BASE_AT = new Date('2000-01-01T00:00:00Z'); // "before any history" — a real timestamp, not -infinity

export interface FeaturedList {
  label: string; // goes into the event source, e.g. 'snapshot-2026-10-18'
  at: Date; // when the list was true
  marketIds: Set<string>;
  changesAt?: Record<string, Date>; // per-game time of the flips INTO this list (default: `at`)
}

export interface SeedEvent {
  marketId: string;
  featured: boolean;
  at: Date;
  source: string;
}

export interface SeedPlan {
  events: SeedEvent[];
  reconcile: SeedEvent[];
  unknownMarketIds: string[]; // in a list but not a card market in this DB (reported, skipped)
  byGame: Record<string, { base: number; on: number; off: number; reconcile: number }>;
}

/** Read-only: the seed events for these lists (oldest first), plus the reconcile events against the live flags.
 *  `reconcileAt` defaults to the trigger's first own event (else now). */
export async function planFeaturedSeed(q: Queryer, lists: FeaturedList[], reconcileAt?: Date): Promise<SeedPlan> {
  if (!lists.length) throw new Error('planFeaturedSeed: at least the base list is required');
  const markets = (
    await q.query<{ id: string; game: string; featured: boolean }>(`SELECT id, game, featured FROM markets WHERE kind = 'card'`)
  ).rows;
  const byId = new Map(markets.map((m) => [m.id, m]));
  const byGame: SeedPlan['byGame'] = {};
  const tally = (game: string) => (byGame[game] ??= { base: 0, on: 0, off: 0, reconcile: 0 });
  const unknown = new Set<string>();
  const events: SeedEvent[] = [];

  const [base, ...later] = lists;
  let prev = new Set<string>();
  for (const id of base.marketIds) {
    const m = byId.get(id);
    if (!m) { unknown.add(id); continue; }
    events.push({ marketId: id, featured: true, at: BASE_AT, source: `seed:${base.label}` });
    tally(m.game).base++;
    prev.add(id);
  }
  for (const list of later) {
    const cur = new Set<string>();
    for (const id of list.marketIds) {
      if (byId.has(id)) cur.add(id);
      else unknown.add(id);
    }
    const when = (id: string) => list.changesAt?.[byId.get(id)!.game] ?? list.at;
    for (const id of cur) if (!prev.has(id)) { events.push({ marketId: id, featured: true, at: when(id), source: `seed:${list.label}` }); tally(byId.get(id)!.game).on++; }
    for (const id of prev) if (!cur.has(id)) { events.push({ marketId: id, featured: false, at: when(id), source: `seed:${list.label}` }); tally(byId.get(id)!.game).off++; }
    prev = cur;
  }

  // Reconcile: the latest state per market across seed events + the trigger's own (non-seed) events vs the flag now.
  const live = (
    await q.query<{ market_id: string; featured: boolean; at: Date }>(
      `SELECT market_id, featured, at FROM featured_events WHERE source NOT LIKE 'seed:%' ORDER BY at, id`,
    )
  ).rows;
  const latest = new Map<string, { featured: boolean; at: Date }>();
  for (const e of [...events.map((x) => ({ market_id: x.marketId, featured: x.featured, at: x.at })), ...live].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    latest.set(e.market_id, { featured: e.featured, at: e.at });
  }
  const at = reconcileAt ?? (live.length ? new Date(live[0].at) : new Date());
  const reconcile: SeedEvent[] = [];
  for (const m of markets) {
    const l = latest.get(m.id);
    if (l ? l.featured !== m.featured : m.featured) {
      reconcile.push({ marketId: m.id, featured: m.featured, at, source: 'seed:reconcile' });
      tally(m.game).reconcile++;
    }
  }
  return { events, reconcile, unknownMarketIds: [...unknown], byGame };
}

/** Write a seed plan in one transaction. Refuses if seed rows exist, unless `replace` (then those rows are removed first). */
export async function applyFeaturedSeed(db: Db, plan: SeedPlan, opts: { replace?: boolean } = {}): Promise<number> {
  return db.tx(async (q) => {
    const existing = (await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM featured_events WHERE source LIKE 'seed:%'`)).rows[0].n;
    if (existing > 0 && !opts.replace) throw new Error(`featured_events already holds ${existing} seed rows — pass --replace to redo the seed`);
    if (existing > 0) await q.query(`DELETE FROM featured_events WHERE source LIKE 'seed:%'`);
    const all = [...plan.events, ...plan.reconcile];
    for (let i = 0; i < all.length; i += 500) {
      const chunk = all.slice(i, i + 500);
      await q.query(
        `INSERT INTO featured_events(market_id, featured, at, source)
         SELECT * FROM unnest($1::text[], $2::boolean[], $3::timestamptz[], $4::text[])`,
        [chunk.map((e) => e.marketId), chunk.map((e) => e.featured), chunk.map((e) => e.at.toISOString()), chunk.map((e) => e.source)],
      );
    }
    return all.length;
  });
}
