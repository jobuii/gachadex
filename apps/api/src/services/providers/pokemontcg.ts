import { getCardPriceVariant, toE6 } from '@pokex/pricing';
import { formatDisplayName } from './display.ts';
import { config } from '../../config.ts';
import type { OracleCard } from '../oracle.ts';

/**
 * pokemontcg.io provider (the legacy/live raw feed, Pokémon-only). Owns everything specific to the
 * pokemontcg card shape — variant picking, metadata extraction, price selection — and emits the
 * provider-agnostic OracleCard the oracle consumes. The tcgpricelookup provider (P3) sits alongside.
 *
 * Note: pokemontcg exposes NO tcgplayer productId (verified live — its `tcgplayer` object is only
 * {prices, updatedAt, url}), so cards from this feed carry no stable cross-provider ids; the P1
 * backfill matches existing markets to tcgpricelookup by name + set + number instead.
 */

/** Card metadata for the detail panel, extracted from the pokemontcg card we already fetch. */
function extractMetadata(c: any): { hp: string | null; retreat: number; attacks: { name: string; damage: string }[]; setName: string | null } {
  return {
    hp: c?.hp ?? null,
    retreat: Array.isArray(c?.retreatCost) ? c.retreatCost.length : (c?.convertedRetreatCost ?? 0),
    attacks: Array.isArray(c?.attacks) ? c.attacks.map((a: any) => ({ name: a?.name ?? '', damage: a?.damage ?? '' })) : [],
    setName: c?.set?.name ?? null,
  };
}

/** Map raw pokemontcg card objects to OracleCards. Unpriced cards map with rawE6=0n (ingest skips them).
 *  Legacy symbols stay the bare pokemontcg id — the upsert key for every existing live market. */
export function fromPokemontcg(raw: any[]): OracleCard[] {
  return raw.map((c) => {
    const { variant, price } = getCardPriceVariant(c); // one walk: the variant and its price can't drift apart
    return {
      game: 'pokemon',
      symbol: c.id,
      cardId: c.id,
      displayName: formatDisplayName(c.name, c.number),
      variant,
      imageSmall: c.images?.small ?? null,
      imageLarge: c.images?.large ?? null,
      setLogo: c.set?.images?.logo ?? null,
      metadata: extractMetadata(c),
      rawE6: toE6(price),
      payload: { tcgplayer: c.tcgplayer ?? null },
      featured: true, // this feed IS the curated top-250 by price — all of it is index-eligible
    };
  });
}

/** Live fetcher: top Pokémon cards by TCGplayer market price (server-side, keyless-ok). */
export async function pokemontcgFetcher(): Promise<OracleCard[]> {
  const url = `${config.pokemontcgBase}/cards?q=supertype:Pok%C3%A9mon&orderBy=-tcgplayer.prices.holofoil.market&pageSize=${config.oraclePageSize}`;
  const headers: Record<string, string> = {};
  if (config.pokemontcgApiKey) headers['X-Api-Key'] = config.pokemontcgApiKey;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`pokemontcg.io responded ${res.status}`);
  const json = (await res.json()) as any;
  return fromPokemontcg(json?.data ?? []);
}
