import { SCALE } from '@pokex/pricing';

/**
 * Index level math (docs/index-series-spec.md). The same per-game baskets are turned into three index levels:
 *   - GJ      (price-weighted / Dow):           period return = Σ P₁ / Σ P₀            (Dutot)
 *   - G&P     (equal-weight / S&P EW):          period return = geometric mean of P₁/P₀ (Jevons)
 *   - Pokedaq (capped / Nasdaq-100):            period return = capped-price-weighted mean of P₁/P₀
 *
 * All three are CHAIN-LINKED: Iₜ = Iₜ₋₁ · Rₜ, with Rₜ measured over the PREVIOUS pass's basket (its snapshot
 * prices P₀) at this pass's prices P₁ — then the basket rebalances to the new top-N. Three rules make that
 * honest (each fixes a measured defect, 2026-10 audit):
 *   1. Leavers count. A card that drops out of a top-N basket usually dropped in price; measuring Rₜ over the
 *      previous basket (not just the cards present in both passes) keeps that fall in the index.
 *   2. Geometric, not arithmetic, for equal weight. The chained arithmetic mean of price relatives (Carli)
 *      drifts upward whenever prices bounce: A 100→200→100 and B 100→50→100 end flat but chain to +56%. It
 *      fails the time-reversal test; Jevons passes it (why official CPIs use it).
 *   3. Outlier guard. A card whose price moves ≥ outlierFactor× (or ≤ 1/outlierFactor×) in ONE pass is a data
 *      error far more often than a market move (e.g. a $0.99 → $1,067 mis-mapped print). It's left out of that
 *      pass's return; its new price becomes the base next pass, so a genuine re-price counts from then on and
 *      a flip-back is caught again.
 * Cards with no usable price this pass (unpriced, or an outlier) are simply left out of Rₜ — the pass's move is
 * imputed from the rest of the basket (class-mean imputation), never forced to zero. Pure (no DB).
 */

/** Indices launch — and re-base — at 1000.000000 points. */
export const BASE_VALUE_E6 = 1_000_000_000n;

export type IndexWeighting = 'price' | 'equal' | 'capped';

/** A catalog entry's weighting → the chain-link method (GJ's catalog weighting is 'price'). */
export function weightingOf(idx: { weighting?: string }): IndexWeighting {
  return idx.weighting === 'equal' || idx.weighting === 'capped' ? idx.weighting : 'price';
}

export interface ConstituentPrice {
  cardId: string;
  priceE6: bigint;
}

export interface ChainOptions {
  outlierFactor: number; // config.indexOutlierFactor
  capBps: number; // capped weighting only (DEFAULT_CAP_BPS)
}

export interface ChainStep {
  levelE6: bigint;
  used: number; // previous-basket cards that contributed a return this pass
  missing: number; // previous-basket cards with no usable price this pass (imputed)
  outliers: string[]; // previous-basket cards excluded by the outlier guard (cardIds)
  launched: boolean; // no prior level/snapshot → started at BASE_VALUE_E6
}

/**
 * One chain link. `prev` = the previous pass's basket snapshot (cardId → price), `cur` = this pass's price for
 * ANY card that has one (basket members AND leavers). Returns the new level.
 */
export function chainStep(
  prevLevelE6: bigint,
  prev: Map<string, bigint>,
  cur: Map<string, bigint>,
  weighting: IndexWeighting,
  opts: ChainOptions,
): ChainStep {
  if (prevLevelE6 <= 0n || prev.size === 0) return { levelE6: BASE_VALUE_E6, used: 0, missing: 0, outliers: [], launched: true };
  const hi = opts.outlierFactor;
  const lo = 1 / opts.outlierFactor;
  const used: { cardId: string; p0: bigint; p1: bigint; rel: number }[] = [];
  const outliers: string[] = [];
  let missing = 0;
  for (const [cardId, p0] of prev) {
    const p1 = cur.get(cardId);
    if (!(p0 > 0n) || p1 == null || !(p1 > 0n)) {
      missing++;
      continue;
    }
    const rel = Number(p1) / Number(p0);
    if (rel >= hi || rel <= lo) {
      outliers.push(cardId);
      continue;
    }
    used.push({ cardId, p0, p1, rel });
  }
  if (used.length === 0) return { levelE6: prevLevelE6, used: 0, missing, outliers, launched: false }; // nothing measurable — carry forward

  let r: number;
  if (weighting === 'price') {
    const s0 = used.reduce((a, u) => a + u.p0, 0n);
    const s1 = used.reduce((a, u) => a + u.p1, 0n);
    r = Number(s1) / Number(s0);
  } else if (weighting === 'equal') {
    r = Math.exp(used.reduce((a, u) => a + Math.log(u.rel), 0) / used.length);
  } else {
    const w = cappedWeights(used.map((u) => ({ cardId: u.cardId, prevE6: u.p0 })), opts.capBps);
    let num = 0;
    let den = 0;
    for (const u of used) {
      const wi = Number(w.get(u.cardId) ?? 0n);
      num += wi * u.rel;
      den += wi;
    }
    r = den > 0 ? num / den : 1;
  }
  return { levelE6: BigInt(Math.round(Number(prevLevelE6) * r)), used: used.length, missing, outliers, launched: false };
}

/**
 * Price weights (from period-start prices) iteratively capped at `capBps`: any weight above the cap is
 * pinned to the cap and the excess redistributed pro-rata to the under-cap names, repeated until none
 * exceed it. Returns cardId -> weight (e6-scaled). Only the RATIOS matter — chainStep normalizes by the
 * weight sum — so the integer-division residual is harmless. Exposed for tests.
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
