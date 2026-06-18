import { SCALE } from '@pokex/pricing';

/**
 * Index weighting methodologies (docs/index-series-spec.md). The same per-game baskets are turned into
 * three index levels by three weighting schemes:
 *   - GJ  (price-weighted / Dow): the divisor method in oracle.ts — NOT here.
 *   - G&P (equal-weight / S&P 500 Equal Weight): every card contributes its % change equally.
 *   - Pokedaq (capped / Nasdaq-100): price-weighted, every card capped at a fixed %.
 *
 * G&P and Pokedaq are CHAIN-LINKED returns: Iₜ = Iₜ₋₁ · (weighted average of Pᵢ,ₜ / Pᵢ,ₜ₋₁). Chaining
 * over the cards present in BOTH passes makes a composition change continuous (an entrant/leaver
 * contributes no return the pass it changes) — the same role GJ's divisor re-peg plays. Pure (no DB).
 */

/** Indices launch — and re-base — at 1000.000000 points. Shared with oracle.ts's price-weighted anchor. */
export const BASE_VALUE_E6 = 1_000_000_000n;

export interface ConstituentPrice {
  cardId: string;
  priceE6: bigint;
}

/** One-period price relative Pₜ / Pₜ₋₁, e6-scaled. */
function relativeE6(curE6: bigint, prevE6: bigint): bigint {
  return (curE6 * SCALE) / prevE6;
}

/** The chain-link set: cards in this pass AND last pass with usable (>0) prices on both sides. */
function commonNames(prevPrices: Map<string, bigint>, members: ConstituentPrice[]): ConstituentPrice[] {
  return members.filter((m) => {
    const p = prevPrices.get(m.cardId);
    return p != null && p > 0n && m.priceE6 > 0n;
  });
}

/**
 * Equal-weight (S&P 500 Equal Weight): each constituent contributes its % change equally — the period
 * return is the simple average of the constituents' price relatives. Flat passes are exact (no drift).
 */
export function equalWeightLevel(
  prevLevelE6: bigint,
  prevPrices: Map<string, bigint>,
  members: ConstituentPrice[],
): bigint {
  if (prevLevelE6 <= 0n || prevPrices.size === 0) return BASE_VALUE_E6; // launch
  const common = commonNames(prevPrices, members);
  if (common.length === 0) return prevLevelE6; // full turnover (never in practice) — carry forward
  let sumRelE6 = 0n;
  for (const m of common) sumRelE6 += relativeE6(m.priceE6, prevPrices.get(m.cardId)!);
  const avgRelE6 = sumRelE6 / BigInt(common.length);
  return (prevLevelE6 * avgRelE6) / SCALE;
}

/**
 * Capped price-weight (Nasdaq-100): price weights, every card capped at `capBps`, the period return the
 * capped-weighted average of price relatives. Flat passes are exact (the weights sum to SCALE exactly).
 */
export function cappedWeightLevel(
  prevLevelE6: bigint,
  prevPrices: Map<string, bigint>,
  members: ConstituentPrice[],
  capBps: number,
): bigint {
  if (prevLevelE6 <= 0n || prevPrices.size === 0) return BASE_VALUE_E6; // launch
  const common = commonNames(prevPrices, members);
  if (common.length === 0) return prevLevelE6;
  const weights = cappedWeights(
    common.map((m) => ({ cardId: m.cardId, prevE6: prevPrices.get(m.cardId)! })),
    capBps,
  );
  // Normalize by the weight sum so the return is the capped-weighted AVERAGE relative: flat passes give
  // exactly SCALE regardless of any integer-division drift in the weights (only the weight ratios matter).
  let num = 0n;
  let wsum = 0n;
  for (const m of common) {
    const w = weights.get(m.cardId) ?? 0n;
    num += w * relativeE6(m.priceE6, prevPrices.get(m.cardId)!);
    wsum += w;
  }
  if (wsum <= 0n) return prevLevelE6;
  return (prevLevelE6 * (num / wsum)) / SCALE;
}

/**
 * Price weights (from period-start prices) iteratively capped at `capBps`: any weight above the cap is
 * pinned to the cap and the excess redistributed pro-rata to the under-cap names, repeated until none
 * exceed it. Returns cardId -> weight (e6-scaled). Only the RATIOS matter — cappedWeightLevel normalizes
 * by the weight sum — so the integer-division residual is harmless. Exposed for tests.
 */
export function cappedWeights(items: { cardId: string; prevE6: bigint }[], capBps: number): Map<string, bigint> {
  const w = new Map<string, bigint>();
  const total = items.reduce((a, i) => a + i.prevE6, 0n);
  if (total <= 0n || items.length === 0) return w;
  const capE6 = (BigInt(capBps) * SCALE) / 10_000n;
  for (const i of items) w.set(i.cardId, (i.prevE6 * SCALE) / total);
  // Redistribute the over-cap excess until everyone is at/under the cap. Each iteration pins at least one
  // more name to the cap, so it converges in ≤ N iterations.
  for (let iter = 0; iter <= items.length; iter++) {
    let excess = 0n;
    let underSum = 0n;
    for (const [, wi] of w) {
      if (wi > capE6) excess += wi - capE6;
      else if (wi < capE6) underSum += wi;
    }
    if (excess === 0n) break;
    if (underSum <= 0n) break; // every name already at the cap (basket too small for the cap) — leave as-is
    for (const [id, wi] of w) {
      if (wi > capE6) w.set(id, capE6);
      else if (wi < capE6) w.set(id, wi + (excess * wi) / underSum);
    }
  }
  return w;
}
