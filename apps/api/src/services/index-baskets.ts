import { INDEX_CATALOG } from '@pokex/shared-types';
import type { ConstituentPrice } from './index-weighting.ts';
import type { ProductType } from './product-type.ts';
import { basketKey } from './index-rules.ts';

/**
 * Index basket construction — the ONE definition, shared by the live ingest (oracle.ts) and the history rebuild
 * (index-rebuild.ts), so a published history can never fork from what live passes print. Pure (no DB).
 *
 * Input: EVERY card priced this pass, with its raw price, PSA-10 price (already resolved, incl. any fetch fallback),
 * product type, and whether it's index-ELIGIBLE (featured, fresh, not halted — each caller decides from its own
 * data). Output, per catalog index: its members (eligible cards only — the basket to snapshot) and `cur` — this
 * pass's price for EVERY priced card of that tier, eligible or not, so chainStep measures a leaver's move even when
 * it left because it was de-featured or went stale (a stale card simply measures as unchanged).
 *   - top-N tiers: the game's singles, price-descending (ties by cardId — deterministic), first N;
 *   - graded: the top `gradedConstituents` singles (by RAW price) that have a PSA-10, at their PSA-10 price;
 *   - sealed: every sealed product, when enabled and at least `sealedMin` exist;
 *   - product type 'other' (e.g. Code Cards) is in no basket.
 */
export interface BasketCard {
  game: string;
  cardId: string;
  priceE6: bigint;
  gradedE6: bigint | null;
  productType: ProductType;
  eligible: boolean; // may be a basket member this pass; every card is priced into `cur` regardless
}

export interface BasketOptions {
  gradedConstituents: number;
  sealedEnabled: boolean;
  sealedMin: number;
  // Index rules v3 (index-membership.ts): fixed member lists by basket ('pokemon:top-100') as card ids. A basket
  // present here takes exactly these members (every one priced this pass — a stale member is carried at its last
  // price, R6); an absent basket keeps the old rule (re-slice the eligible top N).
  members?: Map<string, Set<string>>;
}

export type CatalogIndex = (typeof INDEX_CATALOG)[number];

export interface Basket {
  idx: CatalogIndex;
  members: ConstituentPrice[];
  cur: Map<string, bigint>;
}

/** Price-descending, ties by cardId — the basket order. */
export const byPriceDesc = (a: { cardId: string; priceE6: bigint }, b: { cardId: string; priceE6: bigint }) =>
  b.priceE6 > a.priceE6 ? 1 : b.priceE6 < a.priceE6 ? -1 : a.cardId.localeCompare(b.cardId);

interface GameCards {
  singles: BasketCard[];
  sealed: BasketCard[];
}

export function buildBaskets(cards: BasketCard[], o: BasketOptions): Basket[] {
  const games = new Map<string, GameCards>();
  for (const c of cards) {
    if (c.productType === 'other' || c.priceE6 <= 0n) continue;
    let g = games.get(c.game);
    if (!g) games.set(c.game, (g = { singles: [], sealed: [] }));
    (c.productType === 'sealed' ? g.sealed : g.singles).push(c);
  }
  // Per game, once: the ELIGIBLE lists (members come from these, price-descending) + the price maps over ALL
  // priced cards that every tier of that game shares.
  const derived = new Map<string, { singles: BasketCard[]; sealed: BasketCard[]; singlesPx: Map<string, bigint>; sealedPx: Map<string, bigint>; gradedPx: Map<string, bigint> }>();
  for (const [game, g] of games) {
    derived.set(game, {
      singles: g.singles.filter((c) => c.eligible).sort(byPriceDesc),
      sealed: g.sealed.filter((c) => c.eligible).sort(byPriceDesc),
      singlesPx: new Map(g.singles.map((c) => [c.cardId, c.priceE6])),
      sealedPx: new Map(g.sealed.map((c) => [c.cardId, c.priceE6])),
      gradedPx: new Map(g.singles.filter((c) => c.gradedE6 != null && c.gradedE6 > 0n).map((c) => [c.cardId, c.gradedE6!])),
    });
  }
  const none = { singles: [], sealed: [], singlesPx: new Map(), sealedPx: new Map(), gradedPx: new Map() };
  const toMember = (c: BasketCard) => ({ cardId: c.cardId, priceE6: c.priceE6 });
  return INDEX_CATALOG.map((idx) => {
    const d = derived.get(idx.game) ?? none;
    const fixed = o.members?.get(basketKey(idx.game, idx.tier));
    if (fixed && idx.tier !== 'sealed') {
      const px = idx.tier === 'graded' ? d.gradedPx : d.singlesPx;
      const members = [...px].filter(([cardId]) => fixed.has(cardId)).map(([cardId, priceE6]) => ({ cardId, priceE6 })).sort(byPriceDesc);
      return { idx, members, cur: px };
    }
    if (idx.tier === 'graded') {
      const members = d.singles
        .slice(0, o.gradedConstituents)
        .filter((c) => d.gradedPx.has(c.cardId))
        .map((c) => ({ cardId: c.cardId, priceE6: d.gradedPx.get(c.cardId)! }));
      return { idx, members, cur: d.gradedPx };
    }
    if (idx.tier === 'sealed') {
      const members = o.sealedEnabled && d.sealed.length >= o.sealedMin ? d.sealed.map(toMember) : [];
      return { idx, members, cur: d.sealedPx };
    }
    return { idx, members: idx.topN != null ? d.singles.slice(0, idx.topN).map(toMember) : [], cur: d.singlesPx };
  });
}
