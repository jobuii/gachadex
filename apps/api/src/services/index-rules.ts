/**
 * Index membership rules v3 (2026-10-18 plan, decisions D1–D6, D10) — the PURE part: who is in a basket after a
 * monthly change date, and who leaves between dates. No DB here; index-membership.ts feeds it and stores the result.
 *
 *   R2  rank by raw price (Graded: raw price among cards with a PSA-10), ties by market id.
 *   R3  joining needs: featured, not delisted / reduce-only / low-confidence, a fresh price at the reference time, a
 *       first live price at least `seasoningDays` old (backfill doesn't count), and for Graded a PSA-10.
 *   R4  FTSE-style buffer: a non-member joins at rank ≤ join, a member stays while rank ≤ stay; then exactly N in
 *       rank order — too many → the lowest-ranked go; too few → the highest-ranked cards that may join fill in.
 *   R5  causes (between dates too): delisted; no fresh price for `staleDays`; Graded: no PSA-10 for `staleDays`;
 *       removed by hand. Reduce-only and low-confidence alone are NOT causes.
 *   R11 a card removed by hand stays out until cleared (excluded); one removed for a cause must pass R3 again.
 *   R12 one printing per product: only the product's most valuable printing at the change date can be a member.
 */

export interface TierRules {
  n: number; // basket size
  joinRank: number;
  stayRank: number;
}

/** D2 (FTSE style 90/110, Top 250: 225/275) — Graded uses the Top-100 numbers. */
export function tierRules(tier: string, gradedConstituents: number, stayPct = 110): TierRules | null {
  // join at 90% of N, stay while within stayPct% of N (D2: 110 — the plan's "wider" option is 120)
  const rules = (n: number): TierRules => ({ n, joinRank: Math.round(n * 0.9), stayRank: Math.round((n * stayPct) / 100) });
  if (tier === 'top-100') return rules(100);
  if (tier === 'top-250') return rules(250);
  if (tier === 'graded') return rules(gradedConstituents);
  return null; // sealed: not governed by v3 (out of scope)
}

export const RESERVE_SIZE = 20; // runners-up kept for between-date replacements (D3)

/** A basket's key — 'pokemon:top-100' — shared by the membership rows and buildBaskets' `members` lookup. */
export const basketKey = (game: string, tier: string): string => `${game}:${tier}`;

export interface Candidate {
  marketId: string;
  productKey: string; // TCGplayer product id (else the market id) — R12
  priceE6: bigint; // the ranking price at the reference time
  member: boolean;
  canJoin: boolean; // R3
  cause: string | null; // R5 reason this member must leave (null = none); ignored for non-members
  excluded: boolean; // R11 removed by hand and not cleared
}

export type RemoveReason = 'rank' | 'printing' | 'hand' | string;

export interface Reconstitution {
  members: string[]; // the basket after the change, rank order
  adds: string[];
  removes: { marketId: string; reason: RemoveReason }[];
  reserves: string[]; // next-best cards that may join, rank order (D3)
}

/** A non-member that may join (R3) and isn't removed by hand (R11). */
export const mayJoin = (c: Candidate): boolean => !c.member && c.canJoin && !c.excluded;

const byPriceDesc = (a: Candidate, b: Candidate) => (b.priceE6 > a.priceE6 ? 1 : b.priceE6 < a.priceE6 ? -1 : a.marketId.localeCompare(b.marketId));

/** R12: one printing per product — the most valuable one that is a member or may join (ties by market id): a
 *  printing that can't join (low confidence, unseasoned, excluded) never pushes a member out. */
export function onePerProduct(cands: Candidate[]): { kept: Candidate[]; dropped: Candidate[] } {
  const best = new Map<string, Candidate>();
  const contender = (c: Candidate) => c.member || (c.canJoin && !c.excluded);
  for (const c of [...cands].sort(byPriceDesc)) if (contender(c) && !best.has(c.productKey)) best.set(c.productKey, c);
  for (const c of cands) if (!best.has(c.productKey)) best.set(c.productKey, c); // a product with no contender: harmless (it can't join)
  const keep = new Set([...best.values()].map((c) => c.marketId));
  return { kept: cands.filter((c) => keep.has(c.marketId)), dropped: cands.filter((c) => !keep.has(c.marketId)) };
}

/** Decision B (2026-10-19): who replaces members leaving between change dates — the change's reserves first, then the
 *  best-ranked cards that may join NOW, so a basket doesn't shrink until the next 1st. Never a `barred` card (one that
 *  left for a cause since the last change comes back only at a change date, R11) and never a second printing of a
 *  product already in the basket (R12: `heldProducts`). */
export function substitutes(cands: Candidate[], reserves: string[], count: number, barred: Set<string>, heldProducts: Set<string>): string[] {
  const byId = new Map(cands.map((c) => [c.marketId, c]));
  const order = [...reserves.map((id) => byId.get(id)).filter((c): c is Candidate => c != null), ...[...cands].sort(byPriceDesc)];
  const out: string[] = [];
  const products = new Set(heldProducts);
  for (const c of order) {
    if (out.length >= count) break;
    if (!mayJoin(c) || barred.has(c.marketId) || products.has(c.productKey)) continue; // (a pick's own product blocks a repeat)
    out.push(c.marketId);
    products.add(c.productKey);
  }
  return out;
}

/** A change date (R2–R5, R11, R12): the new basket from the current members and the ranked candidates. */
export function reconstitute(all: Candidate[], t: TierRules, reserveSize = RESERVE_SIZE): Reconstitution {
  const removes: Reconstitution['removes'] = [];
  const { kept, dropped } = onePerProduct(all);
  for (const c of dropped) if (c.member) removes.push({ marketId: c.marketId, reason: 'printing' });
  const ranked = kept.sort(byPriceDesc);
  const rank = new Map(ranked.map((c, i) => [c.marketId, i + 1]));

  const leaveReason = (c: Candidate): string | null => {
    if (c.excluded) return 'hand';
    if (c.cause != null) return c.cause;
    return rank.get(c.marketId)! > t.stayRank ? 'rank' : null;
  };
  const stays: Candidate[] = [];
  for (const c of ranked.filter((x) => x.member)) {
    const reason = leaveReason(c);
    if (reason) removes.push({ marketId: c.marketId, reason });
    else stays.push(c);
  }
  const joiners = ranked.filter((c) => mayJoin(c) && rank.get(c.marketId)! <= t.joinRank);

  let basket = [...stays, ...joiners].sort(byPriceDesc);
  if (basket.length > t.n) {
    for (const c of basket.slice(t.n)) if (c.member) removes.push({ marketId: c.marketId, reason: 'rank' });
    basket = basket.slice(0, t.n);
  }
  const inBasket = new Set(basket.map((c) => c.marketId));
  // Too few: the highest-ranked cards that may join fill in — a member that only failed the stay rank counts as one.
  const removedForRank = new Set(removes.filter((r) => r.reason === 'rank').map((r) => r.marketId));
  const pool = ranked.filter((c) => !inBasket.has(c.marketId) && (mayJoin(c) || removedForRank.has(c.marketId)));
  for (const c of pool) {
    if (basket.length >= t.n) break;
    basket.push(c);
    inBasket.add(c.marketId);
  }
  basket.sort(byPriceDesc);
  const finalIds = new Set(basket.map((c) => c.marketId));
  return {
    members: basket.map((c) => c.marketId),
    adds: basket.filter((c) => !c.member).map((c) => c.marketId),
    removes: removes.filter((r) => !finalIds.has(r.marketId)),
    reserves: ranked.filter((c) => !finalIds.has(c.marketId) && mayJoin(c)).slice(0, reserveSize).map((c) => c.marketId),
  };
}
