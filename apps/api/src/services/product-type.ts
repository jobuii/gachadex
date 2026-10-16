import { parseDisplayName } from './providers/display.ts';

/**
 * What a market's product is: a single CARD, a SEALED product (booster box, display, ETB, bundle, case…), or
 * OTHER (e.g. Pokémon "Code Card" — neither). Card indices hold singles only; sealed has its own per-game
 * basket; other is in no index.
 *
 * The rule uses the provider's structured fields, not the name (measured 2026-10 on live markets):
 *   sealed ⇔ no rarity (null / "None") AND no collector number.
 * Neither field works alone: 141 MTG Alpha/Beta/Unlimited singles have no number (but a rarity), and some
 * Japanese singles have no rarity (but a number). Name keywords are the worst signal — "EX Collector's Tin"
 * and "Tournament Pack" are also the names of promo SINGLES.
 */
export type ProductType = 'single' | 'sealed' | 'other';

export function productTypeOf(rarity: string | null | undefined, number: string | null | undefined): ProductType {
  const r = (rarity ?? '').trim().toLowerCase();
  if (r === 'code card') return 'other';
  const noRarity = r === '' || r === 'none';
  const noNumber = !(number ?? '').trim();
  return noRarity && noNumber ? 'sealed' : 'single';
}

/** The same rule from a stored market row (number lives in display_name as " #…", rarity in metadata). */
export function productTypeOfMarket(displayName: string, rarity: string | null | undefined): ProductType {
  return productTypeOf(rarity, parseDisplayName(displayName).number);
}
