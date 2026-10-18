import { useMemo } from 'react';

// Printing markets (2026-10-18 plan P5, mockup options A + C): one market per printing of a card. Printings of one
// card share a TCGplayer product (`tcgplayerId`); `printing` is the server's key for the variant name (normVariant).

const LABELS = {
  normal: 'Normal', foil: 'Foil', holofoil: 'Holo', reverseholofoil: 'Reverse', firsteditionholofoil: '1st Ed',
  unlimitedholofoil: 'Unlimited', firstedition: '1st Ed', unlimited: 'Unlimited', serializedfoil: 'Serialized',
  masterballreverseholofoil: 'Master Ball', pokeballreverseholofoil: 'Poké Ball', firsteditionnormal: '1st Ed',
};

/** The chip text: a short name for the common printings, else the provider's name split into words (≤ 20 chars). */
export function printingLabel(m) {
  const label = LABELS[m.printing];
  if (label) return label;
  if (!m.variant) return null;
  const words = m.variant.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
  return words.length > 20 ? `${words.slice(0, 19)}…` : words;
}

/** The printing families (id → filter label): printingFamily's results, one colour each (index.css .pc-*). */
export const PRINTING_FAMILIES = [['normal', 'Normal'], ['rev', 'Reverse'], ['holo', 'Holo'], ['first', '1st Ed'], ['foil', 'Foil'], ['alt', 'Alt / other']];

/** One colour per printing family, the same in every list. */
export function printingFamily(m) {
  const k = m.printing ?? '';
  if (k.includes('first')) return 'first';
  if (k.includes('reverse')) return 'rev';
  if (k.includes('holo')) return 'holo';
  if (k.includes('foil')) return 'foil';
  if (k === 'normal' || k === 'unlimited' || !k) return 'normal';
  return 'alt'; // One Piece art versions, stamps, jumbo…
}

/** tcgplayerId → that product's live printing markets, cheapest first — only products with 2+ (a card with one printing
 *  gets no chip, so most lists look as before). */
export function siblingGroups(markets) {
  const by = new Map();
  for (const m of markets ?? []) {
    if (m.kind !== 'card' || !m.tcgplayerId || m.status === 'delisted') continue;
    const list = by.get(m.tcgplayerId) ?? [];
    list.push(m);
    by.set(m.tcgplayerId, list);
  }
  const markE6 = (m) => (m.markE6 ? Number(m.markE6) : Infinity);
  for (const [k, list] of by) {
    if (list.length < 2) by.delete(k);
    else list.sort((a, b) => markE6(a) - markE6(b));
  }
  return by;
}

export const useSiblingGroups = (markets) => useMemo(() => siblingGroups(markets), [markets]);

/** The product's main printing for "main printing only": the featured one (the index's choice, D6), else the dearest
 *  priced one — a client view of value; the server's lookups use MAIN_MARKET_ORDER (featured, else oldest). */
export const isMainPrinting = (m, groups) => {
  const g = groups.get(m.tcgplayerId);
  if (!g) return true;
  const priced = g.filter((x) => x.markE6);
  return (g.find((x) => x.featured) ?? priced[priced.length - 1] ?? g[0]).id === m.id;
};
