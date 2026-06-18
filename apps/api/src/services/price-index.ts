import type { Db } from '../db/client.ts';
import { getJpyUsd } from './providers/fx.ts';
import {
  getDefaultScrydexClient,
  scrydexSlug,
  SCRYDEX_BATCH_SIZE,
  type ScrydexClient,
  type ScrydexCard,
  type ScrydexPrice,
} from './providers/scrydex.ts';
import { getDefaultClient, tplTcgplayerId, type TcgPriceLookupClient, type TplCard } from './providers/tcgpricelookup.ts';

/**
 * Price-index builder (docs §15): populate the `price_index` data lake with the raw TCGplayer market
 * price + the FULL price payload from BOTH feeds, for every card whose raw market is ≥ the floor in
 * either feed. Keyed by TCGplayer product_id (the cross-provider join key). This is the substrate for
 * deriving the trading universe (rank top-N per game by best-available price) — NOT the live markets.
 * Idempotent: re-running upserts by product_id; full payloads are stored so re-derivation never re-fetches.
 */

export const PRICE_INDEX_MIN_USD = 10; // listing floor; matches MIN_LIST_PRICE_USD
const RAW_CONDITION_ORDER = ['NM', 'LP', 'MP']; // Scrydex condition preference
const TPL_CONDITION_ORDER = ['near_mint', 'lightly_played']; // tcgpl condition preference
const GAMES = ['pokemon', 'onepiece', 'mtg'];

/** The raw (ungraded) TCGplayer market for one Scrydex variant, converted to USD. JP-only printings
 *  report JPY — converted via FX; null when JPY and no rate, or no positive raw market. */
export function scrydexVariantRawUsd(prices: ScrydexPrice[] | undefined, fxJpyUsd: number | null): number | null {
  for (const cond of RAW_CONDITION_ORDER) {
    const p = (prices ?? []).find((x) => x.type === 'raw' && x.condition === cond && typeof x.market === 'number' && x.market > 0);
    if (!p) continue;
    const market = p.market as number;
    if (p.currency === 'JPY') return fxJpyUsd && fxJpyUsd > 0 ? market * fxJpyUsd : null;
    if (p.currency && p.currency !== 'USD') return null; // unknown currency — don't mis-price it as USD
    return market; // USD (or unspecified → assume USD, the TCGplayer marketplace default)
  }
  return null;
}

/** The raw TCGplayer market (USD) + eBay 7-day avg for a tcgpl card, from the best available condition. */
export function tplRawMarket(prices: TplCard['prices']): { rawUsd: number | null; ebay7d: number | null } {
  for (const cond of TPL_CONDITION_ORDER) {
    const c = prices?.raw?.[cond];
    if (!c) continue;
    const m = c.tcgplayer?.market;
    if (typeof m === 'number' && m > 0) {
      const e = c.ebay?.avg_7d;
      return { rawUsd: m, ebay7d: typeof e === 'number' && e > 0 ? e : null };
    }
  }
  return { rawUsd: null, ebay7d: null };
}

async function upsertScrydexSide(
  db: Db,
  r: { tcgplayerId: number; game: string; name: string | null; scrydexCardId: string; expansionId: string | null; variant: string | null; rawUsd: number; prices: ScrydexPrice[] },
): Promise<void> {
  await db.query(
    `INSERT INTO price_index (tcgplayer_id, game, name, scrydex_card_id, scrydex_expansion_id, scrydex_variant, scrydex_raw_usd, scrydex_prices, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (tcgplayer_id) DO UPDATE SET
       game = COALESCE(price_index.game, EXCLUDED.game),
       name = COALESCE(EXCLUDED.name, price_index.name),
       scrydex_card_id = EXCLUDED.scrydex_card_id,
       scrydex_expansion_id = EXCLUDED.scrydex_expansion_id,
       scrydex_variant = EXCLUDED.scrydex_variant,
       scrydex_raw_usd = EXCLUDED.scrydex_raw_usd,
       scrydex_prices = EXCLUDED.scrydex_prices,
       updated_at = now()`,
    [r.tcgplayerId, r.game, r.name, r.scrydexCardId, r.expansionId, r.variant, r.rawUsd, JSON.stringify(r.prices)],
  );
}

async function upsertTcgplSide(
  db: Db,
  r: { tcgplayerId: number; game: string; name: string | null; tcgplCardId: string; set: string | null; number: string | null; rawUsd: number; ebay7d: number | null; prices: TplCard['prices'] },
): Promise<void> {
  await db.query(
    `INSERT INTO price_index (tcgplayer_id, game, name, tcgpl_card_id, tcgpl_set, tcgpl_number, tcgpl_raw_usd, tcgpl_ebay_7d, tcgpl_prices, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (tcgplayer_id) DO UPDATE SET
       game = COALESCE(price_index.game, EXCLUDED.game),
       name = COALESCE(EXCLUDED.name, price_index.name),
       tcgpl_card_id = EXCLUDED.tcgpl_card_id,
       tcgpl_set = EXCLUDED.tcgpl_set,
       tcgpl_number = EXCLUDED.tcgpl_number,
       tcgpl_raw_usd = EXCLUDED.tcgpl_raw_usd,
       tcgpl_ebay_7d = EXCLUDED.tcgpl_ebay_7d,
       tcgpl_prices = EXCLUDED.tcgpl_prices,
       updated_at = now()`,
    [r.tcgplayerId, r.game, r.name, r.tcgplCardId, r.set, r.number, r.rawUsd, r.ebay7d, JSON.stringify(r.prices ?? null)],
  );
}

export interface ImportResult {
  scanned: number; // cards (Scrydex) / cards (tcgpl) seen
  stored: number; // product rows upserted (≥ minUsd)
}

/** Enumerate each game's Scrydex catalog (prices included) and upsert the Scrydex side for every variant
 *  whose raw TCGplayer market is ≥ minUsd. One product_id per variant marketplace. */
export async function importScrydexPrices(
  db: Db,
  opts: { client?: ScrydexClient; minUsd?: number; fx?: () => Promise<number | null>; games?: string[]; log?: (m: string) => void } = {},
): Promise<ImportResult> {
  const minUsd = opts.minUsd ?? PRICE_INDEX_MIN_USD;
  const sx = opts.client ?? getDefaultScrydexClient(db);
  const fxJpyUsd = await (opts.fx ?? getJpyUsd)();
  const log = opts.log ?? (() => {});
  const result: ImportResult = { scanned: 0, stored: 0 };

  for (const game of opts.games ?? GAMES) {
    const slug = scrydexSlug(game);
    if (!slug) continue;
    let seen = 0; // ACTUAL cumulative cards received — never page*BATCH (a short non-last page would
    // over-estimate and break early, silently dropping cards). Mirrors the tcgpl offset advance.
    for (let page = 1; ; page++) {
      const res = await sx.searchCards(slug, { page, pageSize: SCRYDEX_BATCH_SIZE }, 'discovery');
      seen += res.data.length;
      for (const card of res.data) {
        result.scanned++;
        for (const [tcgplayerId, variant] of scrydexProducts(card)) {
          const rawUsd = scrydexVariantRawUsd(variant.prices, fxJpyUsd);
          if (rawUsd == null || rawUsd < minUsd) continue;
          await upsertScrydexSide(db, {
            tcgplayerId, game, name: card.name ?? null, scrydexCardId: card.id,
            expansionId: card.expansion?.id ?? null, variant: variant.name ?? null, rawUsd, prices: variant.prices ?? [],
          });
          result.stored++;
        }
      }
      if (res.data.length === 0 || seen >= res.total_count) break;
      if (page % 10 === 0) log(`scrydex ${game}: ${seen}/${res.total_count} scanned, ${result.stored} stored`);
    }
  }
  return result;
}

/** Each (tcgplayer product_id → variant) on a Scrydex card. A product_id can repeat across variants;
 *  the first occurrence wins (later upserts would just overwrite with the same identity). */
function* scrydexProducts(card: ScrydexCard): Generator<[number, NonNullable<ScrydexCard['variants']>[number]]> {
  const seen = new Set<number>();
  for (const v of card.variants ?? []) {
    for (const m of v.marketplaces ?? []) {
      if (m.name !== 'tcgplayer' || m.product_id == null) continue;
      const id = Number(m.product_id);
      if (!Number.isFinite(id) || seen.has(id)) continue;
      seen.add(id);
      yield [id, v];
    }
  }
}

/** Crawl each game's full tcgpl catalog and upsert the tcgpl side for every card whose raw TCGplayer
 *  market is ≥ minUsd. Slow (the provider paces 1 req/s) — runs at 'discovery' priority so it yields. */
export async function importTcgplPrices(
  db: Db,
  opts: { client?: TcgPriceLookupClient; minUsd?: number; games?: string[]; log?: (m: string) => void } = {},
): Promise<ImportResult> {
  const minUsd = opts.minUsd ?? PRICE_INDEX_MIN_USD;
  const tpl = opts.client ?? getDefaultClient(db);
  const log = opts.log ?? (() => {});
  const result: ImportResult = { scanned: 0, stored: 0 };

  for (const game of opts.games ?? GAMES) {
    let offset = 0;
    for (;;) {
      const res = await tpl.searchCards({ game, limit: 100, offset }, 'discovery');
      for (const card of res.data) {
        result.scanned++;
        const tcgplayerId = tplTcgplayerId(card);
        if (tcgplayerId == null) continue;
        const { rawUsd, ebay7d } = tplRawMarket(card.prices);
        if (rawUsd == null || rawUsd < minUsd) continue;
        await upsertTcgplSide(db, {
          tcgplayerId, game, name: card.name ?? null, tcgplCardId: card.id,
          set: card.set?.name ?? null, number: card.number ?? null, rawUsd, ebay7d, prices: card.prices,
        });
        result.stored++;
      }
      offset += res.data.length;
      if (res.data.length === 0 || offset >= res.total) break;
      if (offset % 1000 < 100) log(`tcgpl ${game}: ${offset}/${res.total} scanned, ${result.stored} stored`);
    }
  }
  return result;
}
