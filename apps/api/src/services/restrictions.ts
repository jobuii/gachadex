import type { Db } from '../db/client.ts';

/**
 * Operator view of the oracle price-confidence gate (admin panel). A card market is "restricted"
 * (reduce-only — no new positions) when its provider signals are too thin or disagree too much to
 * trust the price; see priceCard. `restricted` = everything gated right now; `flippedToday` = the
 * markets that crossed INTO restricted since midnight UTC (from market_restriction_events).
 */
export interface RestrictionsReport {
  restricted: { marketId: string; displayName: string; game: string; since: string | null }[];
  flippedToday: { marketId: string; displayName: string; game: string; at: string; reason: string | null }[];
}

export async function restrictionsReport(db: Db): Promise<RestrictionsReport> {
  const current = await db.query<{ market_id: string; display_name: string; game: string; since: string | null }>(
    `SELECT m.id AS market_id, m.display_name, m.game,
            (SELECT max(e.at)::text FROM market_restriction_events e WHERE e.market_id = m.id AND e.restricted) AS since
       FROM markets m
       WHERE m.kind = 'card' AND m.low_confidence
       ORDER BY since DESC NULLS LAST, m.display_name`,
  );
  const flipped = await db.query<{ market_id: string; display_name: string; game: string; at: string; reason: string | null }>(
    `SELECT e.market_id, m.display_name, m.game, e.at::text AS at, e.reason
       FROM market_restriction_events e
       JOIN markets m ON m.id = e.market_id
       WHERE e.restricted AND (e.at AT TIME ZONE 'UTC') >= date_trunc('day', now() AT TIME ZONE 'UTC')
       ORDER BY e.at DESC`,
  );
  return {
    restricted: current.rows.map((r) => ({ marketId: r.market_id, displayName: r.display_name, game: r.game, since: r.since })),
    flippedToday: flipped.rows.map((r) => ({ marketId: r.market_id, displayName: r.display_name, game: r.game, at: r.at, reason: r.reason })),
  };
}
