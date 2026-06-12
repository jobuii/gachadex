import { GAMES } from '@pokex/shared-types';
import type { Db } from '../../db/client.ts';
import { HttpError } from '../../errors.ts';
import { ingestCard } from '../oracle.ts';
import { cardSymbol } from '../markets.ts';
import { seedMarketHistory } from './history.ts';
import {
  fromTplCard,
  isListable,
  rawPriceUsd,
  tplTcgplayerId,
  type TcgPriceLookupClient,
  type TplCard,
} from './tcgpricelookup.ts';

export { isListable, MIN_LIST_PRICE_USD } from './tcgpricelookup.ts';

/**
 * Search-and-bet (P6): search the provider's whole catalog and spin up a market on demand. The
 * search proxy is CACHED (plan: TTL ~1h per (q, game)) so repeat searches never hit the provider;
 * the existing-market join runs fresh on every call so listing state is always live. Creation is
 * idempotent and respects one-market-per-canonical-variant (the tcgplayer_id unique index).
 */

// --- search cache: (game, q) -> provider results. Bounded; misses evict the oldest entry. ---
const SEARCH_TTL_MS = 60 * 60 * 1000;
const SEARCH_CACHE_MAX = 500;
const SEARCH_PAGE = 20;
const searchCache = new Map<string, { at: number; cards: TplCard[] }>();

/** Test hook — the cache is process-wide module state. */
export function clearSearchCache(): void {
  searchCache.clear();
}

export interface CatalogResult {
  providerCardId: string;
  name: string;
  number: string | null;
  setName: string | null;
  rarity: string | null;
  variant: string | null;
  imageSmall: string | null;
  priceUsd: number; // 0 = unpriced
  listable: boolean;
  marketId: string | null; // an existing market for this card (or its canonical tcgplayer variant)
}

export async function searchCatalog(
  db: Db,
  client: TcgPriceLookupClient,
  q: string,
  game: string,
): Promise<CatalogResult[]> {
  const key = `${game}:${q.trim().toLowerCase()}`;
  const hit = searchCache.get(key);
  let cards: TplCard[];
  if (hit && Date.now() - hit.at < SEARCH_TTL_MS) {
    cards = hit.cards;
  } else {
    cards = (await client.searchCards({ q: q.trim(), game, limit: SEARCH_PAGE }, 'search')).data;
    searchCache.delete(key);
    searchCache.set(key, { at: Date.now(), cards });
    if (searchCache.size > SEARCH_CACHE_MAX) searchCache.delete(searchCache.keys().next().value!);
  }

  // Existing markets (never cached): by provider card id, or by tcgplayer product id — a printing
  // variant of an already-listed physical card must offer "trade the existing market", not a twin.
  const ids = cards.map((c) => c.id);
  const tids = [...new Set(cards.map(tplTcgplayerId).filter((t): t is number => t != null))].map(String);
  const existing = ids.length
    ? await db.query<{ id: string; provider_card_id: string | null; tid: string | null }>(
        `SELECT id, provider_card_id, tcgplayer_id::text AS tid FROM markets
          WHERE kind = 'card' AND (provider_card_id = ANY($1::text[]) OR tcgplayer_id = ANY($2::bigint[]))`,
        [ids, tids],
      )
    : { rows: [] };
  const byProv = new Map(existing.rows.filter((r) => r.provider_card_id).map((r) => [r.provider_card_id!, r.id]));
  const byTid = new Map(existing.rows.filter((r) => r.tid).map((r) => [r.tid!, r.id]));

  return cards.map((c) => {
    const tid = tplTcgplayerId(c);
    return {
      providerCardId: c.id,
      name: c.name,
      number: c.number,
      setName: c.set?.name ?? null,
      rarity: c.rarity,
      variant: c.variant,
      imageSmall: c.image_url,
      priceUsd: Math.round(rawPriceUsd(c) * 100) / 100,
      listable: isListable(c),
      marketId: byProv.get(c.id) ?? (tid != null ? byTid.get(String(tid)) : undefined) ?? null,
    };
  });
}

// Dollar min-notional (plan P6): a long-tail market's minimum order is ~>= $1 so dust positions
// can't exist. min_qty rounds UP to the qty step; the $10 gate bounds it to <= 0.1 units.
const MIN_NOTIONAL_UUSDC = 1_000_000n; // $1
const QTY_STEP_E6 = 10_000n; // matches the markets qty_step_e6 default

export function minQtyForPrice(priceE6: bigint): bigint {
  if (priceE6 <= 0n) return QTY_STEP_E6;
  const raw = (MIN_NOTIONAL_UUSDC * 1_000_000n + priceE6 - 1n) / priceE6; // ceil(1e12 / price)
  return ((raw + QTY_STEP_E6 - 1n) / QTY_STEP_E6) * QTY_STEP_E6;
}

async function findExisting(
  db: Db,
  providerCardId: string,
  tcgplayerId: number | null,
): Promise<{ id: string; status: string } | null> {
  const r = await db.query<{ id: string; status: string }>(
    `SELECT id, status FROM markets WHERE kind = 'card' AND (provider_card_id = $1 OR ($2::bigint IS NOT NULL AND tcgplayer_id = $2))
      LIMIT 1`,
    [providerCardId, tcgplayerId],
  );
  return r.rows[0] ?? null;
}

/** Bring a retired (dead long-tail) market back: rejoin the refresh set and reset created_at so the
 *  retirement sweep gives it a fresh 30 days. created_at is ALSO the engine's "activation marker" —
 *  a fresh print (computed_at >= created_at) must land before the market can be OPENED, so the
 *  caller reprices RIGHT AFTER this; the stale pre-retirement mark can never be opened against. */
async function reactivate(db: Db, marketId: string): Promise<void> {
  await db.query(
    `UPDATE markets SET status = 'active', tradeable = true, created_at = now() WHERE id = $1 AND status = 'delisted'`,
    [marketId],
  );
}

/** Re-list a delisted market on a FRESH provider price (never the stale pre-retirement one): reactivate
 *  first (resets the activation marker), then ingest the just-fetched card so its new mark beats it. */
async function reviveWithFreshPrice(db: Db, client: TcgPriceLookupClient, marketId: string, c: TplCard): Promise<void> {
  await reactivate(db, marketId);
  const card = fromTplCard(c, {
    provider_card_id: c.id,
    symbol: cardSymbol(c.game?.slug ?? '', c.id),
    card_id: c.id,
    game: c.game?.slug ?? '',
    featured: false,
  });
  // Stamp the revival print with wall-clock time, NOT the provider updated_at: a market dead for 30+
  // days may share its timestamp with the stale pre-retirement print, which would dedup away and
  // leave no fresh mark. This is a deliberate "reprice now" event (the pokemontcg-path behavior).
  card.observedAt = null;
  if (card.rawE6 > 0n) await ingestCard(db, card, new Date()); // a rejected (outlier) print just leaves it awaiting the next pass
}

/** Create (or return) the market for a provider card — `markets/ensure`. Same card or a printing
 *  variant of the same physical product always lands on the same market (no double-create). */
export async function ensureMarketFromCard(
  db: Db,
  client: TcgPriceLookupClient,
  providerCardId: string,
): Promise<{ marketId: string; created: boolean }> {
  const pre = await findExisting(db, providerCardId, null);
  // Already tracked + live: nothing to do (no provider request spent).
  if (pre && pre.status !== 'delisted') return { marketId: pre.id, created: false };

  const c = await client.getCard(providerCardId, 'search');
  if (!c) throw new HttpError(404, 'card not found', 'card_not_found');

  // Retired market the user wants back: revive it on a fresh price (the listing gate is for NEW
  // markets — a previously-listed card comes back even if its price has since drifted).
  if (pre) {
    await reviveWithFreshPrice(db, client, pre.id, c);
    return { marketId: pre.id, created: false };
  }

  const game = c.game?.slug ?? '';
  if (!(GAMES as readonly string[]).includes(game)) throw new HttpError(422, `unsupported game '${game}'`, 'unsupported_game');
  if (!isListable(c)) {
    throw new HttpError(
      422,
      'card not listable: needs a TCGplayer NM market price >= $10 with a corroborating eBay average',
      'below_listing_threshold',
    );
  }

  // Identity comes from US (game-namespaced symbol), prices/images from the provider — exactly the
  // tracked-refresh path, so the 6h oracle pass picks the new market up with zero special-casing.
  const card = fromTplCard(c, {
    provider_card_id: c.id,
    symbol: cardSymbol(game, c.id),
    card_id: c.id,
    game,
    featured: false, // long-tail: tradeable but NEVER an index constituent
  });

  let marketId: string;
  try {
    marketId = await ingestCard(db, card, new Date(), undefined, { minQtyE6: minQtyForPrice(card.rawE6) });
  } catch (e) {
    // Unique-index race or a printing twin of an already-listed product (the tcgplayer_id unique
    // index is the arbiter): the canonical market won — return it (reviving it if it was retired).
    const lost = await findExisting(db, c.id, tplTcgplayerId(c));
    if (lost) {
      if (lost.status === 'delisted') await reviveWithFreshPrice(db, client, lost.id, c);
      return { marketId: lost.id, created: false };
    }
    throw e;
  }
  // Chart seed in the background ('discovery' priority queues behind live traffic — never block the
  // response on it); the hourly sweep is the safety net if it fails.
  void seedMarketHistory(db, client, { id: marketId, providerCardId: c.id }).catch(() => {});
  return { marketId, created: true };
}
