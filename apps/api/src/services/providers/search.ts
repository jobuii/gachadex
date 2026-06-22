import { GAMES } from '@pokex/shared-types';
import { toE6 } from '@pokex/pricing';
import type { Db } from '../../db/client.ts';
import { HttpError } from '../../errors.ts';
import { ingestCard, type OracleCard } from '../oracle.ts';
import { cardSymbol } from '../markets.ts';
import { seedMarketHistory } from './history.ts';
import {
  fromTplCard,
  isListable,
  MIN_LIST_PRICE_USD,
  rawPriceUsd,
  tplTcgplayerId,
  type TcgPriceLookupClient,
  type TplCard,
} from './tcgpricelookup.ts';
import {
  combinePrice,
  EMPTY_CROSS,
  extractRaw,
  fromScrydexCard,
  scrydexSlug,
  toUsd,
  type ScrydexCard,
  type ScrydexClient,
  type ScrydexRaw,
  type ScrydexTracked,
} from './scrydex.ts';
import { getJpyUsd } from './fx.ts';

export { isListable, MIN_LIST_PRICE_USD } from './tcgpricelookup.ts';

/**
 * Search-and-bet (P6): search the provider's whole catalog and spin up a market on demand. Provider
 * routing mirrors the live pricing oracle — Scrydex serves the games it covers (Pokémon, MTG), tcgpl
 * serves One Piece (Scrydex has no OP catalogue). So the catalogue search no longer depends on the
 * tcgpl key for the bulk of the universe. The search proxy is CACHED (TTL ~1h per (via, q, game)) so
 * repeat searches never hit the provider; the existing-market join runs fresh on every call so listing
 * state is always live. Creation is idempotent and respects one-market-per-canonical-variant (the
 * tcgplayer_id unique index).
 */

/** Both provider clients — `searchCatalog`/`ensureMarketFromCard` pick one per game. */
export interface CatalogClients {
  scrydex: ScrydexClient;
  tcgpl: TcgPriceLookupClient;
}

/** Which provider serves a game's catalogue: Scrydex where it has coverage, tcgpl for One Piece. */
function searchVia(game: string): 'scrydex' | 'tcgpl' {
  return game !== 'onepiece' && scrydexSlug(game) != null ? 'scrydex' : 'tcgpl';
}

// --- search cache: (via, game, q) -> provider candidates. Bounded; misses evict the oldest entry. ---
const SEARCH_TTL_MS = 60 * 60 * 1000;
const SEARCH_CACHE_MAX = 500;
const SEARCH_PAGE = 20;
const searchCache = new Map<string, { at: number; candidates: CatalogCandidate[] }>();

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

/** Provider-agnostic search hit, BEFORE the existing-market join. `source` drives both the join keys
 *  and which provider `ensureMarketFromCard` calls (it's re-derived from `game`, never trusted from the
 *  client). `providerCardId` is what `/markets/ensure` receives: a Scrydex card id or a tcgpl card id. */
interface CatalogCandidate {
  providerCardId: string;
  source: 'scrydex' | 'tcgpl';
  scrydexCardId: string | null;
  tcgplayerId: number | null;
  name: string;
  number: string | null;
  setName: string | null;
  rarity: string | null;
  variant: string | null;
  imageSmall: string | null;
  priceUsd: number;
  listable: boolean;
}

/** The best (tcgplayer_id, raw quote) across a Scrydex card's variants — the printing we'd list. Scrydex
 *  nests printings as `variants[]`, each with its own TCGplayer `product_id`; pick the one with a
 *  product_id AND a positive raw price, highest market first. `extractRaw` does the per-variant parse. */
function bestScrydexRaw(card: ScrydexCard, fxJpyUsd: number | null): { tcgplayerId: number; raw: ScrydexRaw } | null {
  const ids = new Set<number>();
  for (const v of card.variants ?? []) {
    for (const m of v.marketplaces ?? []) {
      const n = Number(m.product_id);
      if (Number.isFinite(n) && n > 0) ids.add(n);
    }
  }
  let best: { tcgplayerId: number; raw: ScrydexRaw } | null = null;
  let bestUsd = 0;
  for (const id of ids) {
    const raw = extractRaw(card, id);
    if (!raw) continue;
    // Rank in USD, NOT the native magnitude — a JPY printing's `market` number is ~100x a USD one, so a
    // raw compare would always pick the (usually cheaper) Japanese variant and mis-list it. A variant we
    // can't price in USD (JPY with no FX rate) can't be listed anyway, so skip it.
    const usd = toUsd(raw, fxJpyUsd);
    if (!usd || !(usd.market > 0)) continue;
    if (best == null || usd.market > bestUsd) {
      best = { tcgplayerId: id, raw };
      bestUsd = usd.market;
    }
  }
  return best;
}

function scrydexCandidate(card: ScrydexCard, fxJpyUsd: number | null): CatalogCandidate {
  const best = bestScrydexRaw(card, fxJpyUsd);
  const usd = best ? toUsd(best.raw, fxJpyUsd) : null;
  const priceUsd = usd && usd.market > 0 ? Math.round(usd.market * 100) / 100 : 0;
  const front = (card.images ?? []).find((i) => i.type === 'front') ?? (card.images ?? [])[0];
  return {
    providerCardId: card.id,
    source: 'scrydex',
    scrydexCardId: card.id,
    tcgplayerId: best?.tcgplayerId ?? null,
    name: card.name ?? card.id,
    number: card.number ?? card.printed_number ?? null,
    setName: card.expansion?.name ?? null,
    rarity: card.rarity ?? null,
    variant: best?.raw.variant ?? null,
    imageSmall: front?.small ?? null,
    priceUsd,
    // Listable needs a tcgplayer_id: the oracle prices a Scrydex market via extractRaw, which matches the
    // variant by product_id — no product_id ⇒ no anchor ⇒ unpriceable, so don't offer to list it.
    listable: best != null && priceUsd >= MIN_LIST_PRICE_USD,
  };
}

function tcgplCandidate(c: TplCard): CatalogCandidate {
  return {
    providerCardId: c.id,
    source: 'tcgpl',
    scrydexCardId: null,
    tcgplayerId: tplTcgplayerId(c),
    name: c.name,
    number: c.number,
    setName: c.set?.name ?? null,
    rarity: c.rarity,
    variant: c.variant,
    imageSmall: c.image_url,
    priceUsd: Math.round(rawPriceUsd(c) * 100) / 100,
    listable: isListable(c),
  };
}

export async function searchCatalog(
  db: Db,
  clients: CatalogClients,
  q: string,
  game: string,
  fx: () => Promise<number | null> = () => getJpyUsd(), // injectable so tests stay hermetic (no live FX call)
): Promise<CatalogResult[]> {
  const via = searchVia(game);
  const key = `${via}:${game}:${q.trim().toLowerCase()}`;
  const hit = searchCache.get(key);
  let candidates: CatalogCandidate[];
  if (hit && Date.now() - hit.at < SEARCH_TTL_MS) {
    candidates = hit.candidates;
  } else {
    if (via === 'scrydex') {
      const slug = scrydexSlug(game)!; // searchVia guarantees a slug for the scrydex branch
      const page = await clients.scrydex.searchCards(slug, { q: q.trim(), pageSize: SEARCH_PAGE }, 'search');
      const rate = await fx();
      candidates = page.data.map((c) => scrydexCandidate(c, rate));
    } else {
      const cards = (await clients.tcgpl.searchCards({ q: q.trim(), game, limit: SEARCH_PAGE }, 'search')).data;
      candidates = cards.map(tcgplCandidate);
    }
    searchCache.delete(key);
    searchCache.set(key, { at: Date.now(), candidates });
    if (searchCache.size > SEARCH_CACHE_MAX) searchCache.delete(searchCache.keys().next().value!);
  }

  // Existing markets (never cached): by the card's own provider id (scrydex_card_id or tcgpl
  // provider_card_id) OR the canonical tcgplayer product id — a printing variant of an already-listed
  // physical card must offer "trade the existing market", not a twin.
  const sxIds = candidates.filter((c) => c.scrydexCardId).map((c) => c.scrydexCardId!);
  const provIds = candidates.filter((c) => c.source === 'tcgpl').map((c) => c.providerCardId);
  const tids = [...new Set(candidates.map((c) => c.tcgplayerId).filter((t): t is number => t != null))].map(String);
  const existing =
    sxIds.length || provIds.length || tids.length
      ? await db.query<{ id: string; sid: string | null; pid: string | null; tid: string | null }>(
          `SELECT id, scrydex_card_id AS sid, provider_card_id AS pid, tcgplayer_id::text AS tid FROM markets
            WHERE kind = 'card' AND (scrydex_card_id = ANY($1::text[]) OR provider_card_id = ANY($2::text[]) OR tcgplayer_id = ANY($3::bigint[]))`,
          [sxIds, provIds, tids],
        )
      : { rows: [] };
  const byScrydex = new Map(existing.rows.filter((r) => r.sid).map((r) => [r.sid!, r.id]));
  const byProv = new Map(existing.rows.filter((r) => r.pid).map((r) => [r.pid!, r.id]));
  const byTid = new Map(existing.rows.filter((r) => r.tid).map((r) => [r.tid!, r.id]));

  return candidates.map((c) => ({
    providerCardId: c.providerCardId,
    name: c.name,
    number: c.number,
    setName: c.setName,
    rarity: c.rarity,
    variant: c.variant,
    imageSmall: c.imageSmall,
    priceUsd: c.priceUsd,
    listable: c.listable,
    marketId:
      (c.scrydexCardId ? byScrydex.get(c.scrydexCardId) : undefined) ??
      (c.source === 'tcgpl' ? byProv.get(c.providerCardId) : undefined) ??
      (c.tcgplayerId != null ? byTid.get(String(c.tcgplayerId)) : undefined) ??
      null,
  }));
}

// --- existing-market lookups (shared) ---

async function findByScrydexCardId(db: Db, scrydexCardId: string): Promise<{ id: string; status: string } | null> {
  const r = await db.query<{ id: string; status: string }>(
    `SELECT id, status FROM markets WHERE kind = 'card' AND scrydex_card_id = $1 LIMIT 1`,
    [scrydexCardId],
  );
  return r.rows[0] ?? null;
}

async function findByTcgplayerId(db: Db, tcgplayerId: number | null): Promise<{ id: string; status: string } | null> {
  if (tcgplayerId == null) return null;
  const r = await db.query<{ id: string; status: string }>(
    `SELECT id, status FROM markets WHERE kind = 'card' AND tcgplayer_id = $1 LIMIT 1`,
    [tcgplayerId],
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

// ===========================================================================
// tcgpl path (One Piece) — unchanged behaviour, the original search-and-bet implementation.
// ===========================================================================

async function findExistingTcgpl(db: Db, providerCardId: string, tcgplayerId: number | null): Promise<{ id: string; status: string } | null> {
  const r = await db.query<{ id: string; status: string }>(
    `SELECT id, status FROM markets WHERE kind = 'card' AND (provider_card_id = $1 OR ($2::bigint IS NOT NULL AND tcgplayer_id = $2))
      LIMIT 1`,
    [providerCardId, tcgplayerId],
  );
  return r.rows[0] ?? null;
}

/** Re-list a delisted market on a FRESH provider price (never the stale pre-retirement one): reactivate
 *  first (resets the activation marker), then ingest the just-fetched card so its new mark beats it. */
async function reviveTcgpl(db: Db, marketId: string, c: TplCard): Promise<void> {
  await reactivate(db, marketId);
  const card = fromTplCard(c, {
    provider_card_id: c.id,
    symbol: cardSymbol(c.game?.slug ?? '', c.id),
    card_id: c.id,
    game: c.game?.slug ?? '',
    featured: false,
  });
  // Stamp the revival print with wall-clock time, NOT the provider last_price_update: a market dead for
  // 30+ days may carry a timestamp that collides with the stale pre-retirement print, which would dedup
  // away (ON CONFLICT) and leave no fresh mark to clear the freshness gate. Wall-clock guarantees a new
  // source_observed_at, so a fresh print + mark always lands. This is a deliberate "reprice now" event.
  card.observedAt = null;
  if (card.rawE6 > 0n) await ingestCard(db, card, new Date());
}

async function ensureFromTcgpl(db: Db, client: TcgPriceLookupClient, providerCardId: string): Promise<{ marketId: string; created: boolean }> {
  const pre = await findExistingTcgpl(db, providerCardId, null);
  if (pre && pre.status !== 'delisted') return { marketId: pre.id, created: false };

  const c = await client.getCard(providerCardId, 'search');
  if (!c) throw new HttpError(404, 'card not found', 'card_not_found');

  if (pre) {
    await reviveTcgpl(db, pre.id, c);
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

  const card = fromTplCard(c, {
    provider_card_id: c.id,
    symbol: cardSymbol(game, c.id),
    card_id: c.id,
    game,
    featured: false, // long-tail: tradeable but NEVER an index constituent
  });

  let marketId: string;
  try {
    marketId = await ingestCard(db, card, new Date());
  } catch (e) {
    const lost = await findExistingTcgpl(db, c.id, tplTcgplayerId(c));
    if (lost) {
      if (lost.status === 'delisted') await reviveTcgpl(db, lost.id, c);
      return { marketId: lost.id, created: false };
    }
    throw e;
  }
  void seedMarketHistory(db, client, { id: marketId, providerCardId: c.id }).catch(() => {});
  return { marketId, created: true };
}

// ===========================================================================
// Scrydex path (Pokémon, MTG) — the primary provider for the games it covers.
// ===========================================================================

/** Build the market-ingest card from a Scrydex card. Identity comes from US (game-namespaced symbol),
 *  price/display from Scrydex. provider_card_id is null (no tcgpl id), so the oracle prices it off the
 *  Scrydex anchor (extractRaw needs the tcgplayer_id) — combinePrice gains the tcgpl cross-check only
 *  if/when the card is later matched to a tcgpl id. */
function buildScrydexCard(c: ScrydexCard, best: { tcgplayerId: number; raw: ScrydexRaw }, priceUsd: number, tradeable: boolean, game: string): OracleCard {
  const tracked: ScrydexTracked = {
    scrydex_card_id: c.id,
    provider_card_id: null,
    symbol: cardSymbol(game, c.id),
    card_id: c.id,
    game,
    tcgplayer_id: best.tcgplayerId,
    featured: false, // long-tail: tradeable but NEVER an index constituent
  };
  const card = fromScrydexCard(c, tracked);
  card.rawE6 = toE6(priceUsd);
  card.confident = tradeable;
  // Stamp the Scrydex ids on the card so the CREATE upsert sets them ATOMICALLY with the row — no window
  // where scrydex_card_id and provider_card_id are both null (which would orphan the market as unpriceable).
  card.scrydexCardId = c.id;
  card.scrydexExpansionId = c.expansion?.id ?? null;
  // observedAt stays null (fromScrydexCard) → ingest stamps wall-clock, guaranteeing a fresh print that
  // clears the activation gate (and, on a revive, beats any stale pre-retirement mark).
  return card;
}

/** Set scrydex_card_id + scrydex_expansion_id directly on an EXISTING (revived) market — a symbol-
 *  independent UPDATE by id, so it works even when the revived row carries an old tcgpl symbol. (NEW
 *  markets get these stamped atomically by the create upsert via buildScrydexCard — no separate write.) */
async function stampScrydexIds(db: Db, marketId: string, c: ScrydexCard): Promise<void> {
  await db.query(`UPDATE markets SET scrydex_card_id = $1, scrydex_expansion_id = $2 WHERE id = $3`, [
    c.id,
    c.expansion?.id ?? null,
    marketId,
  ]);
}

async function reviveScrydex(
  db: Db,
  marketId: string,
  c: ScrydexCard,
  best: { tcgplayerId: number; raw: ScrydexRaw } | null,
  game: string,
  rate: number | null,
): Promise<void> {
  await reactivate(db, marketId);
  await stampScrydexIds(db, marketId, c); // symbol-independent — always anchors THIS row on Scrydex
  if (!best) return; // no usable price right now — the next oracle pass reprices it off the Scrydex anchor
  const combined = combinePrice(best.raw, EMPTY_CROSS, rate); // no tcgpl cross-check at listing time; the oracle adds it on the next refresh
  if (combined.priceUsd > 0) {
    const card = buildScrydexCard(c, best, combined.priceUsd, combined.tier === 'tradeable', game);
    // Best-effort fresh-mark reprice. A market created by the OLD tcgpl path carries a tcgpl symbol, so
    // this scrydex-symbol upsert won't match it (it'd hit the tcgplayer_id unique index) — ignore that;
    // the row is already reactivated + scrydex-stamped, so the next oracle pass reprices it.
    await ingestCard(db, card, new Date()).catch(() => {});
  }
}

async function ensureFromScrydex(
  db: Db,
  client: ScrydexClient,
  scrydexCardId: string,
  game: string,
  fx: () => Promise<number | null>,
): Promise<{ marketId: string; created: boolean }> {
  const slug = scrydexSlug(game);
  if (!slug) throw new HttpError(422, `unsupported game '${game}'`, 'unsupported_game');

  const pre = await findByScrydexCardId(db, scrydexCardId);
  if (pre && pre.status !== 'delisted') return { marketId: pre.id, created: false };

  const c = await client.getCard(slug, scrydexCardId, 'search');
  if (!c) throw new HttpError(404, 'card not found', 'card_not_found');
  const rate = await fx(); // resolve once: bestScrydexRaw ranks variants in USD, combinePrice prices in USD
  const best = bestScrydexRaw(c, rate);

  // Retired market the user wants back: revive on a fresh price (the listing gate is for NEW markets).
  if (pre) {
    await reviveScrydex(db, pre.id, c, best, game, rate);
    return { marketId: pre.id, created: false };
  }

  if (!best) {
    throw new HttpError(422, 'card not listable: no TCGplayer-priced printing on Scrydex', 'below_listing_threshold');
  }
  const combined = combinePrice(best.raw, EMPTY_CROSS, rate); // no tcgpl cross-check at listing time; the oracle adds it on the next refresh
  if (!(combined.priceUsd >= MIN_LIST_PRICE_USD)) {
    throw new HttpError(422, `card not listable: needs a Scrydex market price >= $${MIN_LIST_PRICE_USD}`, 'below_listing_threshold');
  }

  // Canonical dedup: a printing twin of an already-listed product shares its tcgplayer_id.
  const dup = await findByTcgplayerId(db, best.tcgplayerId);
  if (dup) {
    if (dup.status !== 'delisted') return { marketId: dup.id, created: false };
    await reviveScrydex(db, dup.id, c, best, game, rate);
    return { marketId: dup.id, created: false };
  }

  // buildScrydexCard carries scrydex_card_id/expansion_id, so the create upsert stamps them ATOMICALLY
  // with the row (no orphan window). provider_card_id stays null — the oracle anchors on scrydex_card_id.
  const card = buildScrydexCard(c, best, combined.priceUsd, combined.tier === 'tradeable', game);
  let marketId: string;
  try {
    marketId = await ingestCard(db, card, new Date());
  } catch (e) {
    // Unique-index race (the tcgplayer_id unique index is the arbiter): the canonical market won.
    const lost = await findByTcgplayerId(db, best.tcgplayerId);
    if (lost) {
      if (lost.status === 'delisted') await reviveScrydex(db, lost.id, c, best, game, rate);
      return { marketId: lost.id, created: false };
    }
    throw e;
  }
  // No tcgpl provider_card_id and Scrydex has no daily-history endpoint → no chart seed; the hourly
  // sweep + live prints build the candles from here.
  return { marketId, created: true };
}

/** Create (or return) the market for a provider card — `markets/ensure`. Routes per game (Scrydex for
 *  the games it covers, tcgpl for One Piece). Same card or a printing variant of the same physical
 *  product always lands on the same market (no double-create). */
export async function ensureMarketFromCard(
  db: Db,
  clients: CatalogClients,
  providerCardId: string,
  game: string,
  fx: () => Promise<number | null> = () => getJpyUsd(),
): Promise<{ marketId: string; created: boolean }> {
  return searchVia(game) === 'scrydex'
    ? ensureFromScrydex(db, clients.scrydex, providerCardId, game, fx)
    : ensureFromTcgpl(db, clients.tcgpl, providerCardId);
}
