import type { Db } from '../db/client.ts';
import { cardSymbol, upsertCardMarket } from './markets.ts';
import { toCardUpsert } from './oracle.ts';
import { getDefaultScrydexClient, scrydexSlug, fromScrydexCard, type ScrydexClient, type ScrydexTracked } from './providers/scrydex.ts';
import { getDefaultClient, fromTplCard, type TcgPriceLookupClient, type TrackedMarket } from './providers/tcgpricelookup.ts';

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

export interface ApplyResult {
  toCreate: number;
  toUpdate: number;
  toUnfeature: number;
  requiresScrydex: number;
  created: number;
  updated: number;
  unfeatured: number;
  fetchFailures: number;
}

/**
 * Re-curate `markets` to the derived universe. Open-position-safe: drop-outs only lose `featured`
 * (status/tradeable unchanged → still priced; the 30d retireDeadMarkets sweep eventually delists dead
 * ones and already skips markets with open positions). `requires_scrydex` markets are created but the
 * /markets list hides them until ORACLE_PRIMARY=scrydex. Dry-run by default — pass apply:true to write.
 */
export async function applyUniverse(
  db: Db,
  derivation: UniverseDerivation,
  opts: { apply?: boolean; scrydex?: ScrydexClient; tpl?: TcgPriceLookupClient; log?: (m: string) => void } = {},
): Promise<ApplyResult> {
  const apply = opts.apply ?? false;
  const log = opts.log ?? (() => {});
  const sx = opts.scrydex ?? getDefaultScrydexClient(db);
  const tpl = opts.tpl ?? getDefaultClient(db);

  // existing card markets keyed by tcgplayer_id
  const existing = new Map<number, { id: string; featured: boolean }>();
  for (const r of (
    await db.query<{ id: string; tcgplayer_id: string; featured: boolean }>(
      `SELECT id, tcgplayer_id, featured FROM markets WHERE kind='card' AND tcgplayer_id IS NOT NULL`,
    )
  ).rows)
    existing.set(Number(r.tcgplayer_id), { id: r.id, featured: r.featured });

  const derivedTids = new Set(derivation.markets.map((m) => m.tcgplayerId));
  const entrants = derivation.markets.filter((m) => !existing.has(m.tcgplayerId)); // brand-new markets to create
  const updates = derivation.markets.filter((m) => existing.has(m.tcgplayerId)); // already listed → (re)feature
  const dropTids = [...existing].filter(([tid, m]) => m.featured && !derivedTids.has(tid)).map(([tid]) => tid);

  const result: ApplyResult = {
    toCreate: entrants.length, toUpdate: updates.length, toUnfeature: dropTids.length,
    requiresScrydex: derivation.summary.requiresScrydex, created: 0, updated: 0, unfeatured: 0, fetchFailures: 0,
  };
  if (!apply) return result;

  // 1. (re)feature already-listed markets + stamp Scrydex ids / requires_scrydex
  for (const m of updates) {
    await db.query(
      `UPDATE markets SET featured=true,
         scrydex_card_id=COALESCE($2, scrydex_card_id), scrydex_expansion_id=COALESCE($3, scrydex_expansion_id),
         requires_scrydex=$4 WHERE tcgplayer_id=$1`,
      [m.tcgplayerId, m.scrydexCardId, m.scrydexExpansionId, m.requiresScrydex],
    );
    result.updated++;
  }
  log(`re-featured ${result.updated} existing markets`);

  // 2. create brand-new entrants — Scrydex card for display/images when we have its id, else tcgpl
  const viaScrydex = entrants.filter((m) => m.scrydexCardId);
  const viaTpl = entrants.filter((m) => !m.scrydexCardId && m.tcgplCardId);
  for (const game of [...new Set(viaScrydex.map((m) => m.game))]) {
    const slug = scrydexSlug(game);
    if (!slug) continue;
    const group = viaScrydex.filter((m) => m.game === game);
    const cards = new Map((await sx.getCardsByIds(slug, group.map((m) => m.scrydexCardId as string), 'discovery')).map((c) => [c.id, c]));
    for (const m of group) {
      const card = cards.get(m.scrydexCardId as string);
      if (!card) { result.fetchFailures++; continue; }
      const providerId = m.tcgplCardId ?? (m.scrydexCardId as string);
      const t: ScrydexTracked = {
        scrydex_card_id: m.scrydexCardId as string, provider_card_id: m.tcgplCardId ?? null,
        symbol: cardSymbol(game, providerId), card_id: providerId, game, tcgplayer_id: m.tcgplayerId, featured: true,
      };
      const id = await upsertCardMarket(db, { ...toCardUpsert(fromScrydexCard(card, t)), featured: true });
      await db.query(`UPDATE markets SET scrydex_card_id=$2, scrydex_expansion_id=$3, requires_scrydex=$4 WHERE id=$1`,
        [id, m.scrydexCardId, m.scrydexExpansionId, m.requiresScrydex]);
      result.created++;
    }
  }
  if (viaTpl.length) {
    const cards = new Map((await tpl.getCardsByIds(viaTpl.map((m) => m.tcgplCardId as string), 'discovery')).map((c) => [c.id, c]));
    for (const m of viaTpl) {
      const c = cards.get(m.tcgplCardId as string);
      if (!c) { result.fetchFailures++; continue; }
      const t: TrackedMarket = { provider_card_id: c.id, symbol: cardSymbol(m.game, c.id), card_id: c.id, game: m.game, featured: true };
      const id = await upsertCardMarket(db, { ...toCardUpsert(fromTplCard(c, t)), featured: true });
      await db.query(`UPDATE markets SET scrydex_card_id=COALESCE($2, scrydex_card_id), requires_scrydex=$3 WHERE id=$1`,
        [id, m.scrydexCardId, m.requiresScrydex]);
      result.created++;
    }
  }
  log(`created ${result.created} new markets (${result.fetchFailures} fetch failures)`);

  // 3. un-feature drop-outs — status/tradeable untouched, so they keep pricing (open-position-safe)
  if (dropTids.length) {
    await db.query(`UPDATE markets SET featured=false WHERE tcgplayer_id = ANY($1)`, [dropTids]);
    result.unfeatured = dropTids.length;
  }
  log(`un-featured ${result.unfeatured} drop-outs`);
  return result;
}
