import { syntheticMark } from '@pokex/pricing';
import { publish } from './bus.ts';
import { config } from '../config.ts';
import { liveKnob } from './live-knob.ts';
import type { Queryer } from '../db/client.ts';
import type { MarketRow } from './markets.ts';

/**
 * Compute and persist the synthetic mark for a market, then publish it.
 *   mark = clamp(index * (1 + premium), ±max_dev),  premium = clamp(k * skew/depth, ±cap)
 * With skew = 0 (no open interest) the mark equals the index. The engine calls this with
 * live skew/depth on every trade so the price moves intraday. Depth falls back to the
 * configured floor only when the caller passes 0 (e.g. the skew-0 ingest path, where it's moot).
 *
 * MARK GUARD (§6a, ORACLE_PRIMARY=scrydex): when the price-update path passes a `guard`, an
 * UNCORROBORATED per-update jump beyond the clamp threshold is CAPPED (the displayed = traded =
 * liquidation mark creeps toward a persistent move over a few updates, but a one-print glitch reverts
 * before the cap is exhausted — no wrongful liquidation). eBay (the independent venue) corroborating
 * the move bypasses the clamp and adopts the candidate immediately. No `guard` (the trade path, the
 * index path, the legacy feeds) → behaves exactly as before. The guard is never silent: it persists
 * markets.mark_clamped + the candidate, and logs engage/disengage to mark_clamp_events.
 */

/** Per-update cap on an uncorroborated mark move (bps of the current mark). Live-tunable (no deploy):
 *  tighter than §6's 40% spike-gate because this protects money, not just opens. */
const markClamp = liveKnob('mark_clamp_bps', 2500, (v) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 100 || n > 9000) throw new Error('mark_clamp_bps out of range');
  return n;
});
export const getMarkClampBps = markClamp.get;
export const loadMarkClampBps = markClamp.load;
export const setMarkClampBps = markClamp.set;
export const markClampView = (): { bps: number; default: number } => ({ bps: markClamp.get(), default: markClamp.default });

/** Mark-guard context for one price update (only the price-update path supplies it). */
export interface MarkGuardInput {
  corroborated: boolean; // eBay (independent venue) confirms the move's direction+magnitude → no clamp
  clampBps: number; // per-update cap (the caller passes the live mark_clamp_bps knob)
}

/** Persist the mark-guard state and log transitions, mirroring applyConfidence. Refreshes the candidate
 *  the mark is creeping toward on every clamped update; flips markets.mark_clamped + writes a
 *  mark_clamp_events row only when the guard engages or disengages. */
export async function applyMarkClamp(
  q: Queryer,
  market: MarketRow,
  clamped: boolean,
  candidateE6: bigint,
  adoptedE6: bigint,
  reason?: string,
): Promise<void> {
  if (clamped === market.mark_clamped) {
    if (clamped) await q.query(`UPDATE markets SET mark_candidate_e6 = $1 WHERE id = $2`, [candidateE6.toString(), market.id]);
    return; // no transition — just keep the candidate fresh for the admin panel
  }
  await q.query(
    `UPDATE markets SET mark_clamped = $1, clamped_since = $2, mark_candidate_e6 = $3 WHERE id = $4`,
    [clamped, clamped ? new Date().toISOString() : null, clamped ? candidateE6.toString() : null, market.id],
  );
  await q.query(
    `INSERT INTO mark_clamp_events(market_id, clamped, candidate_e6, adopted_e6, reason) VALUES($1, $2, $3, $4, $5)`,
    [
      market.id,
      clamped,
      candidateE6.toString(),
      adoptedE6.toString(),
      reason ?? (clamped ? 'uncorroborated jump beyond the clamp threshold' : 'mark guard released (corroborated or back within band)'),
    ],
  );
}

/** The latest mark written for a market (the per-update clamp anchor). Orders by id too so a tie on
 *  computed_at returns the genuinely-newest row. */
export async function lastMarkE6(q: Queryer, marketId: string): Promise<bigint | null> {
  const r = await q.query<{ m: string }>(
    `SELECT mark_price_e6::text AS m FROM marks WHERE market_id = $1 ORDER BY computed_at DESC, id DESC LIMIT 1`,
    [marketId],
  );
  return r.rows[0] ? BigInt(r.rows[0].m) : null;
}

export async function recomputeMark(
  q: Queryer,
  market: MarketRow,
  indexE6: bigint,
  skewUusdc: bigint,
  depthUusdc: bigint,
  guard?: MarkGuardInput,
): Promise<bigint> {
  const { markE6: candidateE6, premiumE6 } = syntheticMark({
    indexE6,
    skewUusdc,
    depthUusdc: depthUusdc > 0n ? depthUusdc : config.depthFloorUusdc,
    kE6: BigInt(market.skew_k_e6),
    premiumCapE6: BigInt(market.premium_cap_e6),
    maxDevBps: market.max_dev_bps,
  });

  // Mark guard: cap an uncorroborated per-update jump beyond the clamp threshold (§6a).
  let adoptedE6 = candidateE6;
  // The index the engine recomputes the mark from on the NEXT trade (getLatestMarkIndex reads this).
  // While clamped it must be the adopted (guarded) value — otherwise the next trade recomputes from the
  // raw candidate and max_dev snaps the mark straight back to the un-guarded jump, defeating the guard.
  let workingIndexE6 = indexE6;
  if (guard) {
    const last = await lastMarkE6(q, market.id);
    let clamped = false;
    if (last != null && last > 0n && !guard.corroborated) {
      const bps = BigInt(guard.clampBps);
      const diff = candidateE6 > last ? candidateE6 - last : last - candidateE6;
      if (diff * 10_000n > bps * last) {
        // cap the change at clampBps of the current mark, in the candidate's direction
        adoptedE6 = candidateE6 > last ? (last * (10_000n + bps)) / 10_000n : (last * (10_000n - bps)) / 10_000n;
        if (adoptedE6 < 1n) adoptedE6 = 1n; // never write a 0n mark — `last > 0n` would then silently gate the guard off forever
        clamped = true;
        workingIndexE6 = adoptedE6; // trades creep with the guarded mark, not the raw jump
      }
    }
    await applyMarkClamp(q, market, clamped, candidateE6, adoptedE6);
  }

  await q.query(
    `INSERT INTO marks(market_id, mark_price_e6, index_price_e6, skew_uusdc, premium_e6)
     VALUES($1, $2, $3, $4, $5)`,
    [market.id, adoptedE6.toString(), workingIndexE6.toString(), skewUusdc.toString(), premiumE6.toString()],
  );
  publish(`mark:${market.id}`, 'mark', {
    marketId: market.id,
    markE6: adoptedE6.toString(),
    indexE6: workingIndexE6.toString(),
    premiumE6: premiumE6.toString(),
    ts: new Date().toISOString(),
  });
  return adoptedE6;
}
