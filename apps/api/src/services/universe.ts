import type { Db } from '../db/client.ts';

/**
 * Universe derivation (docs/price-index-universe-rederivation.md): from the `price_index` data lake,
 * compute the trading universe — the English top-N/game (ranked by the per-game preferred feed's raw
 * TCGplayer market) PLUS a separate JPY>$threshold set. This REPLACES the old median-ranked featured
 * set. The re-curation that lands this onto `markets` lives in applyUniverse (open-position-safe);
 * deriveUniverse is the pure read/compute, so it can be dry-run and tested in isolation.
 *
 * Per-game price tiebreak (which feed's price ranks + displays a card present in both):
 *   pokemon, mtg -> Scrydex preferred (fresher); onepiece -> tcgpl preferred (Scrydex's OP catalog is thin).
 * Language: a card whose Scrydex raw price is in JPY is Japanese-market → the JPY set; everything else
 *   (incl. USD-priced "Japanese exclusive" TCGplayer products) is English.
 * requiresScrydex: a card with NO usable tcgpl price can only be priced by Scrydex — it must stay hidden
 *   until ORACLE_PRIMARY=scrydex (under tcgpl-primary it has no mark). Covers the JP set + Scrydex-only EN.
 */

export const UNIVERSE_TOP_N = 250;
export const JPY_FLOOR_USD = 100;
const GAMES = ['pokemon', 'onepiece', 'mtg'];

export interface DerivedMarket {
  tcgplayerId: number;
  game: string;
  name: string | null;
  lang: 'en' | 'jp';
  chosenUsd: number;
  reason: 'en-top' | 'jpy-floor';
  scrydexCardId: string | null;
  scrydexExpansionId: string | null;
  tcgplCardId: string | null;
  requiresScrydex: boolean;
}

export interface UniverseDerivation {
  markets: DerivedMarket[];
  summary: {
    total: number;
    requiresScrydex: number;
    byGame: Record<string, { enTop: number; jpyFloor: number }>;
  };
}

interface Row {
  tcgplayer_id: string;
  game: string;
  name: string | null;
  lang: 'en' | 'jp';
  chosen_usd: string;
  reason: 'en-top' | 'jpy-floor';
  scrydex_card_id: string | null;
  scrydex_expansion_id: string | null;
  tcgpl_card_id: string | null;
  requires_scrydex: boolean;
}

/** Derive the proposed trading universe from price_index. Pure read — writes nothing. */
export async function deriveUniverse(
  db: Db,
  opts: { topN?: number; jpyFloorUsd?: number; games?: string[] } = {},
): Promise<UniverseDerivation> {
  const topN = opts.topN ?? UNIVERSE_TOP_N;
  const jpyFloor = opts.jpyFloorUsd ?? JPY_FLOOR_USD;
  const games = opts.games ?? GAMES;

  const { rows } = await db.query<Row>(
    `WITH cls AS (
       SELECT tcgplayer_id, game, name, scrydex_card_id, scrydex_expansion_id, tcgpl_card_id,
         -- per-game preferred feed for the ranking/display price
         CASE WHEN game = 'onepiece' THEN COALESCE(tcgpl_raw_usd, scrydex_raw_usd)
              ELSE COALESCE(scrydex_raw_usd, tcgpl_raw_usd) END AS chosen_usd,
         -- Japanese-market iff the Scrydex raw price is quoted in JPY
         CASE WHEN EXISTS (
                SELECT 1 FROM jsonb_array_elements(COALESCE(scrydex_prices, '[]'::jsonb)) e
                WHERE e->>'type' = 'raw' AND e->>'currency' = 'JPY'
              ) THEN 'jp' ELSE 'en' END AS lang,
         -- can't be priced by tcgpl → needs Scrydex-primary to have a mark (stay hidden until the flip)
         (tcgpl_raw_usd IS NULL) AS requires_scrydex
       FROM price_index
       WHERE game = ANY($3)
     ),
     en AS (
       SELECT *, row_number() OVER (PARTITION BY game ORDER BY chosen_usd DESC NULLS LAST) AS rk
       FROM cls WHERE lang = 'en' AND chosen_usd IS NOT NULL
     )
     SELECT tcgplayer_id, game, name, lang, chosen_usd, 'en-top' AS reason,
            scrydex_card_id, scrydex_expansion_id, tcgpl_card_id, requires_scrydex
       FROM en WHERE rk <= $1
     UNION ALL
     SELECT tcgplayer_id, game, name, lang, chosen_usd, 'jpy-floor' AS reason,
            scrydex_card_id, scrydex_expansion_id, tcgpl_card_id, true AS requires_scrydex
       FROM cls WHERE lang = 'jp' AND chosen_usd >= $2`,
    [topN, jpyFloor, games],
  );

  const markets: DerivedMarket[] = rows.map((r) => ({
    tcgplayerId: Number(r.tcgplayer_id),
    game: r.game,
    name: r.name,
    lang: r.lang,
    chosenUsd: Number(r.chosen_usd),
    reason: r.reason,
    scrydexCardId: r.scrydex_card_id,
    scrydexExpansionId: r.scrydex_expansion_id,
    tcgplCardId: r.tcgpl_card_id,
    requiresScrydex: r.requires_scrydex,
  }));

  const byGame: Record<string, { enTop: number; jpyFloor: number }> = {};
  for (const g of games) byGame[g] = { enTop: 0, jpyFloor: 0 };
  for (const m of markets) {
    const b = (byGame[m.game] ??= { enTop: 0, jpyFloor: 0 });
    if (m.reason === 'en-top') b.enTop++;
    else b.jpyFloor++;
  }

  return {
    markets,
    summary: { total: markets.length, requiresScrydex: markets.filter((m) => m.requiresScrydex).length, byGame },
  };
}
