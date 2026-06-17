import type { Db } from '../db/client.ts';

/**
 * Operator view of the mark guard (§6a; admin panel, beside restrictions). A card market is "clamped"
 * when an uncorroborated >threshold price jump capped the per-update mark move — the displayed mark
 * creeps toward the candidate rather than jumping, so a bad/glitched print can't wrongfully liquidate.
 * `clamped` = every market guarded right now (candidate vs adopted, gap %, since); `flippedToday` = the
 * engage/disengage transitions since midnight UTC (from mark_clamp_events). Never a silent guard.
 */
export interface MarkGuardsReport {
  clamped: {
    marketId: string;
    displayName: string;
    game: string;
    since: string | null; // clamped_since — duration is now() − this
    candidateE6: string | null; // the un-clamped candidate we're creeping toward
    adoptedE6: string | null; // the mark actually shown/traded right now (latest marks row)
    gapPct: number | null; // (candidate − adopted) / adopted, %
  }[];
  flippedToday: {
    marketId: string;
    displayName: string;
    game: string;
    at: string;
    clamped: boolean; // true = engaged, false = released
    candidateE6: string;
    adoptedE6: string;
    reason: string | null;
  }[];
}

export async function markGuardsReport(db: Db): Promise<MarkGuardsReport> {
  const current = await db.query<{
    market_id: string; display_name: string; game: string; since: string | null; candidate_e6: string | null; adopted_e6: string | null;
  }>(
    `SELECT m.id AS market_id, m.display_name, m.game, m.clamped_since::text AS since,
            m.mark_candidate_e6::text AS candidate_e6,
            (SELECT mark_price_e6::text FROM marks WHERE market_id = m.id ORDER BY computed_at DESC, id DESC LIMIT 1) AS adopted_e6
       FROM markets m
       WHERE m.kind = 'card' AND m.mark_clamped
       ORDER BY m.clamped_since DESC NULLS LAST, m.display_name`,
  );
  const flipped = await db.query<{
    market_id: string; display_name: string; game: string; at: string; clamped: boolean; candidate_e6: string; adopted_e6: string; reason: string | null;
  }>(
    `SELECT e.market_id, m.display_name, m.game, e.at::text AS at, e.clamped,
            e.candidate_e6::text AS candidate_e6, e.adopted_e6::text AS adopted_e6, e.reason
       FROM mark_clamp_events e
       JOIN markets m ON m.id = e.market_id
       WHERE (e.at AT TIME ZONE 'UTC') >= date_trunc('day', now() AT TIME ZONE 'UTC')
       ORDER BY e.at DESC`,
  );
  return {
    clamped: current.rows.map((r) => {
      const cand = r.candidate_e6 != null ? BigInt(r.candidate_e6) : null;
      const adopt = r.adopted_e6 != null ? BigInt(r.adopted_e6) : null;
      const gapPct = cand != null && adopt != null && adopt > 0n ? Number(((cand - adopt) * 10_000n) / adopt) / 100 : null;
      return { marketId: r.market_id, displayName: r.display_name, game: r.game, since: r.since, candidateE6: r.candidate_e6, adoptedE6: r.adopted_e6, gapPct };
    }),
    flippedToday: flipped.rows.map((r) => ({
      marketId: r.market_id, displayName: r.display_name, game: r.game, at: r.at, clamped: r.clamped,
      candidateE6: r.candidate_e6, adoptedE6: r.adopted_e6, reason: r.reason,
    })),
  };
}
