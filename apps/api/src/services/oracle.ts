import { randomUUID } from 'node:crypto';
import { toE6 } from '@pokex/pricing';
import { INDEX_CATALOG, DEFAULT_CAP_BPS } from '@pokex/shared-types';
import { config } from '../config.ts';
import type { Db, Queryer } from '../db/client.ts';
import { upsertCardMarket, upsertIndexMarket, getMarketById, type CardUpsert } from './markets.ts';
import { recomputeMark, getMarkClampBps } from './marks.ts';
import { pokemontcgFetcher } from './providers/pokemontcg.ts';
import { fetchTrackedCards } from './providers/tcgpricelookup.ts';
import { fetchScrydexTrackedCards } from './providers/scrydex.ts';
import { chainStep, weightingOf, type ConstituentPrice } from './index-weighting.ts';
import { buildBaskets, byPriceDesc, type BasketCard } from './index-baskets.ts';
import type { ProductType } from './product-type.ts';

/**
 * Provider-agnostic card snapshot — the seam between price providers and the oracle (P2 of the
 * tcgpricelookup plan). Each provider module (providers/pokemontcg.ts; tcgpricelookup in P3) owns its
 * own response shape and emits these; `ingest` knows no provider specifics.
 */
export interface OracleCard {
  game: string; // 'pokemon' | 'onepiece' | 'mtg'
  symbol: string; // market symbol: legacy bare id (pokemontcg) or cardSymbol(game, id) (providers)
  cardId: string; // provider display id — keys index constituents + the graded write
  tcgplayerId?: number | null; // stable cross-provider ids (markets.tcgplayer_id / provider_card_id)
  providerCardId?: string | null;
  scrydexCardId?: string | null; // set when a market is listed/priced via Scrydex (stamped atomically with the upsert)
  scrydexExpansionId?: string | null;
  displayName: string;
  variant: string | null;
  imageSmall: string | null;
  imageLarge?: string | null;
  setLogo?: string | null;
  metadata?: unknown; // provider-extracted detail-panel JSON (markets.metadata column)
  rawE6: bigint; // raw spot in micro-USD; 0n = unpriced (skipped by ingest)
  confident?: boolean; // false => low price confidence (thin/disagreeing signals): restrict the card to reduce-only
  markCorroborated?: boolean; // present => engage the §6a mark guard; true => eBay confirms this move, adopt without clamp (absent => no guard, legacy behaviour)
  gradedE6?: bigint | null; // PSA-10 in micro-USD when the provider supplies it inline (P3); else the gradedFetcher fallback runs
  observedAt?: Date | null; // provider freshness timestamp; null/absent -> the ingest pass wall-clock (legacy behavior)
  payload?: unknown; // audit payload stored on the oracle print
  featured?: boolean; // index-constituent eligible (P4): only featured cards enter the per-game baskets
  productType?: ProductType; // single | sealed | other (product-type.ts): only singles enter card tiers; sealed feeds the Sealed tier; absent = single (legacy feed)
}

/** OracleCard -> the market upsert payload. ONE mapping (ingest + discovery both use it), so the
 *  two write paths can never drift on which fields a provider refresh updates. */
export function toCardUpsert(c: OracleCard): CardUpsert {
  return {
    game: c.game,
    symbol: c.symbol,
    cardId: c.cardId,
    displayName: c.displayName,
    variant: c.variant,
    imageSmall: c.imageSmall,
    imageLarge: c.imageLarge,
    setLogo: c.setLogo,
    metadata: c.metadata,
    tcgplayerId: c.tcgplayerId,
    providerCardId: c.providerCardId,
    scrydexCardId: c.scrydexCardId,
    scrydexExpansionId: c.scrydexExpansionId,
    featured: c.featured, // undefined keeps the stored flag (rebalanced by the discovery job)
    gradedE6: c.gradedE6, // Scrydex-first PSA-10; persisted per-print (COALESCEd so null never clobbers)
    productType: c.productType, // undefined keeps the stored classification
  };
}

/** Returns the cards to ingest. Injectable for tests. */
export type CardFetcher = () => Promise<OracleCard[]>;


/** Returns the PSA-10 graded price (USD) for a card, or null. Injectable for tests. */
export type GradedFetcher = (card: OracleCard) => Promise<number | null>;

/** JustTCG graded fallback — used when the raw provider doesn't supply gradedE6 inline. */
async function fetchGradedPrice(card: OracleCard): Promise<number | null> {
  if (!config.justtcgApiKey) return null;
  const query = card.tcgplayerId ? `tcgplayerId=${card.tcgplayerId}` : `cardId=${encodeURIComponent(card.cardId)}`;
  try {
    const res = await fetch(`${config.justtcgBase}/v1/cards?${query}`, { headers: { 'x-api-key': config.justtcgApiKey } });
    if (!res.ok) return null;
    const json = (await res.json()) as any;
    const row = Array.isArray(json) ? json[0] : (json?.data?.[0] ?? json);
    const psa10 = row?.prices?.psa10 ?? row?.prices?.['psa 10'] ?? row?.prices?.['psa-10'];
    const n = psa10 != null ? Number(psa10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** Record an oracle print. Dedup is HYBRID — a print lands when EITHER the provider's freshness
 *  timestamp is new OR the computed value moved since the last accepted print:
 *   - New `source_observed_at` (provider re-priced): the insert succeeds, even at an unchanged value
 *     (a flat but live feed) — and every insert's fresh `ingested_at` keeps the staleness breaker fed.
 *   - Same timestamp but a CHANGED value: the provider moved the price WITHOUT advancing its clock
 *     (its `last_price_update` is frequently null, so we fall back to a near-static `updated_at`), or
 *     our pricing logic changed. The provider timestamp would collide, so we re-stamp the move on the
 *     ingest wall-clock and record it — otherwise a real move (and the new median taking effect on a
 *     frozen card) would be lost.
 *   - Same timestamp AND same value: a genuine duplicate — skip.
 *  This only ever ADDS writes vs pure timestamp-dedup, so it cannot re-trip the 36h staleness breaker.
 *  Manipulation is handled upstream by the median price and gap risk by the engine — no outlier reject.
 *  Returns whether a row was written (so callers skip a stray mark recompute on a no-op). */
async function recordOracle(
  q: Queryer,
  marketId: string,
  indexE6: bigint,
  observedAt: Date,
  payload: unknown,
): Promise<boolean> {
  const json = JSON.stringify(payload ?? null);
  const insert = (at: Date) =>
    q.query<{ id: string }>(
      `INSERT INTO oracle_prices(market_id, index_price_e6, raw_payload, source_observed_at, is_accepted)
       VALUES($1, $2, $3, $4, true)
       ON CONFLICT(market_id, source_observed_at) DO NOTHING
       RETURNING id`,
      [marketId, indexE6.toString(), json, at.toISOString()],
    );
  // Timestamp path: a new provider snapshot records, whatever the value.
  const byTimestamp = await insert(observedAt);
  if (byTimestamp.rows.length > 0) return true;
  // The provider re-used its timestamp: record it only if the value moved since the last accepted print.
  // Order by id (insertion order), NOT source_observed_at: a value-move re-stamp (below) carries the
  // ingest wall-clock, which sorts newer than any historical provider timestamp — so source_observed_at
  // ordering could return a stale row and drop a real move (the same hazard markets.ts avoids).
  const last = await q.query<{ v: string }>(
    `SELECT index_price_e6::text AS v FROM oracle_prices
     WHERE market_id = $1 AND is_accepted ORDER BY id DESC LIMIT 1`,
    [marketId],
  );
  if (last.rows[0] && BigInt(last.rows[0].v) === indexE6) return false; // same timestamp AND same value -> duplicate
  const byValue = await insert(new Date()); // re-stamp the move on the ingest wall-clock so it lands
  return byValue.rows.length > 0;
}

/** The flag-selected live fetcher (ORACLE_PRIMARY): cutover/rollback is an env flip + restart, no code deploy. */
function primaryFetcher(db: Db): CardFetcher {
  switch (config.oraclePrimary) {
    case 'scrydex':
      return () => fetchScrydexTrackedCards(db);
    case 'tcgpricelookup':
      return () => fetchTrackedCards(db);
    default:
      return pokemontcgFetcher;
  }
}

/** Ingest a price snapshot: upsert card markets, record prints, recompute marks, rebuild indices. */
/** Upsert one card's market, record its print, recompute its mark — the per-card unit of `ingest`,
 *  also the creation path for on-demand markets (P6 `markets/ensure`). Operator-pinned markets keep
 *  their manual price (the upsert still refreshes display fields). Returns the market id. */
/** The audit payload stored on a card print, plus the resolved PSA-10 as a provider-neutral `gradedE6` — what the
 *  index history rebuild reads back (older prints are replayed from the provider fields instead). */
function printPayload(c: OracleCard): unknown {
  if (c.gradedE6 == null || c.gradedE6 <= 0n) return c.payload ?? null;
  const base = c.payload && typeof c.payload === 'object' ? (c.payload as Record<string, unknown>) : {};
  return { ...base, gradedE6: c.gradedE6.toString() };
}

export async function ingestCard(
  db: Db,
  c: OracleCard,
  fallbackObservedAt: Date,
  pinned?: Set<string>,
  extra?: Partial<CardUpsert>, // creation-time overrides (e.g. a custom per-market qty floor)
): Promise<string> {
  const marketId = await db.tx((q) => upsertCardMarket(q, { ...toCardUpsert(c), ...extra }));
  if (pinned?.has(marketId)) return marketId; // manual override in effect — skip the auto print + mark
  const recorded = await db.tx((q) =>
    recordOracle(q, marketId, c.rawE6, c.observedAt ?? fallbackObservedAt, printPayload(c)),
  );
  if (recorded) {
    const market = await getMarketById(db, marketId);
    // Mark guard (§6a) engages only when the provider supplies a corroboration signal (the Scrydex
    // path); the legacy feeds pass none and recompute exactly as before.
    const guard = c.markCorroborated !== undefined ? { corroborated: c.markCorroborated, clampBps: getMarkClampBps() } : undefined;
    if (market) await db.tx((q) => recomputeMark(q, market, c.rawE6, 0n, 0n, guard));
  }
  // tx-wrap so the flag flip and its audit row commit atomically (matches the manual-price path).
  if (c.confident !== undefined) await db.tx((q) => applyConfidence(q, marketId, c.confident!));
  return marketId;
}

/** Set a card market's price-confidence gate (low_confidence => engine blocks new positions). Appends a
 *  market_restriction_events row ONLY when the flag flips, so the admin views show genuine transitions.
 *  Takes a Queryer so it composes inside a transaction (e.g. the manual-price pin). */
export async function applyConfidence(q: Queryer, marketId: string, confident: boolean, reason?: string): Promise<void> {
  const low = !confident;
  const flip = await q.query<{ id: string }>(
    `UPDATE markets SET low_confidence = $1 WHERE id = $2 AND low_confidence IS DISTINCT FROM $1 RETURNING id`,
    [low, marketId],
  );
  if (flip.rows.length > 0) {
    await q.query(`INSERT INTO market_restriction_events(market_id, restricted, reason) VALUES($1, $2, $3)`, [
      marketId,
      low,
      reason ?? (low ? 'low price confidence (thin or disagreeing signals)' : 'price confidence restored'),
    ]);
  }
}

/** Ingest a SUBSET of cards (the webhook re-price path, §8): upsert + print + mark + confidence per
 *  card, reusing ingestCard (so the mark guard runs). Deliberately skips the index rebuild — a webhook
 *  re-prices the named cards; the index baskets are rebuilt by the next full `ingest` poll, never from a
 *  partial set (that would mutate a basket from a handful of constituents). Returns the count priced. */
export async function ingestScopedCards(db: Db, cards: OracleCard[]): Promise<number> {
  const priced = cards.filter((c) => c.rawE6 > 0n);
  if (priced.length === 0) return 0;
  const pinnedRows = await db.query<{ id: string }>(`SELECT id FROM markets WHERE price_pinned`);
  const pinned = new Set(pinnedRows.rows.map((r) => r.id));
  const at = new Date();
  for (const c of priced) await ingestCard(db, c, at, pinned);
  return priced.length;
}

/** Re-price every tracked market in the given Scrydex expansions (the prices.raw_updated webhook, §8):
 *  scoped Scrydex+tcgpl fetch joined by tcgplayer_id, then ingestScopedCards. Returns cards re-priced. */
export async function repriceExpansions(
  db: Db,
  expansionIds: string[],
  // injectable clients/fx for tests (the route passes none); mirror fetchScrydexTrackedCards's params
  opts: {
    sxClient?: Parameters<typeof fetchScrydexTrackedCards>[1];
    tplClient?: Parameters<typeof fetchScrydexTrackedCards>[2];
    fx?: Parameters<typeof fetchScrydexTrackedCards>[3];
  } = {},
): Promise<number> {
  // Gate on the active feed: a Scrydex webhook drives pricing ONLY under ORACLE_PRIMARY=scrydex, so the
  // flag is the SINGLE on/off and a rollback (flag → tcgpricelookup) cleanly stops webhook-driven
  // re-prices. The webhook route still 200-acks every (validly-signed) event — it just doesn't apply
  // Scrydex pricing here when Scrydex isn't the primary feed.
  if (config.oraclePrimary !== 'scrydex' || expansionIds.length === 0) return 0;
  const cards = await fetchScrydexTrackedCards(db, opts.sxClient, opts.tplClient, opts.fx, expansionIds);
  return ingestScopedCards(db, cards);
}

export async function ingest(
  db: Db,
  fetcher?: CardFetcher,
  gradedFetcher: GradedFetcher | null = config.justtcgApiKey ? fetchGradedPrice : null,
): Promise<{ cards: number; indices: number; graded: number }> {
  const passObservedAt = new Date();
  const priced = (await (fetcher ?? primaryFetcher(db))()).filter((c) => c.rawE6 > 0n);

  // Operator-pinned markets carry a manual price (ROADMAP §2) — the auto-oracle never overwrites them.
  const pinnedRows = await db.query<{ id: string }>(`SELECT id FROM markets WHERE price_pinned`);
  const pinned = new Set(pinnedRows.rows.map((r) => r.id));

  for (const c of priced) await ingestCard(db, c, passObservedAt, pinned);

  // Index baskets are PER-GAME and FEATURED-ONLY (P4): the tracked universe (everything priced above)
  // and the index constituents are deliberately distinct sets, so long-tail on-demand markets can never
  // mutate the Top-100/250 baskets. featured comes from the card (pokemontcg = its curated top-250;
  // tcgpricelookup = the market row's flag, rebalanced only by the discovery job). Only cards with a fresh
  // price are eligible (indexEligibleCardIds); the baskets themselves come from buildBaskets (index-baskets.ts),
  // the one definition the history rebuild replays too.
  // Every priced card goes in (so a leaver's move is measured); only featured + fresh ones may be members.
  const eligible = await indexEligibleCardIds(db);
  const basketCards: BasketCard[] = priced.map((c) => ({
    game: c.game, cardId: c.cardId, priceE6: c.rawE6, gradedE6: c.gradedE6 ?? null, productType: c.productType ?? 'single',
    eligible: !!c.featured && eligible.has(c.cardId),
  }));

  // Graded (PSA-10) prices for the top-N singles per game — powers the Graded index + per-card graded panel.
  // Providers that carry graded inline (Scrydex ladder / tcgpl) need no extra fetch; the gradedFetcher
  // (JustTCG) is the fallback for top-N cards without it. Resolved here so buildBaskets stays pure.
  const oracleByCard = new Map(priced.map((c) => [c.cardId, c]));
  const singlesByGame = new Map<string, BasketCard[]>();
  for (const c of basketCards) {
    if (c.productType !== 'single' || !c.eligible) continue;
    const list = singlesByGame.get(c.game) ?? [];
    list.push(c);
    singlesByGame.set(c.game, list);
  }
  let gradedTotal = 0;
  for (const list of singlesByGame.values()) {
    for (const b of list.sort(byPriceDesc).slice(0, config.gradedConstituents)) {
      if (b.gradedE6 == null && gradedFetcher) {
        const g = await gradedFetcher(oracleByCard.get(b.cardId)!);
        if (g != null) b.gradedE6 = toE6(g); // non-positive values are dropped by the guard below + in buildBaskets
      }
      if (b.gradedE6 != null && b.gradedE6 > 0n) {
        await db.query(`UPDATE markets SET graded_psa10_e6=$1 WHERE card_id=$2 AND kind='card'`, [b.gradedE6.toString(), b.cardId]);
        gradedTotal++;
      }
    }
  }
  // PSA-10 history (schema: graded_prints): the PSA-10 every priced single carries into this pass's Graded baskets
  // (members AND leavers; null = none) — a row only when it changed, so the history rebuild replays exactly this.
  const singles = basketCards.filter((c) => c.productType === 'single');
  await db.query(
    `INSERT INTO graded_prints(market_id, graded_e6)
     SELECT m.id, u.g FROM unnest($1::text[], $2::bigint[]) AS u(card_id, g)
       JOIN markets m ON m.card_id = u.card_id AND m.kind = 'card'
      WHERE u.g IS DISTINCT FROM (SELECT p.graded_e6 FROM graded_prints p WHERE p.market_id = m.id ORDER BY p.id DESC LIMIT 1)
         OR NOT EXISTS (SELECT 1 FROM graded_prints p WHERE p.market_id = m.id)`,
    [singles.map((c) => c.cardId), singles.map((c) => (c.gradedE6 != null && c.gradedE6 > 0n ? c.gradedE6.toString() : null))],
  );

  let indices = 0;
  const baskets = buildBaskets(basketCards, {
    gradedConstituents: config.gradedConstituents,
    sealedEnabled: config.sealedIndexEnabled,
    sealedMin: config.sealedIndexMinConstituents,
  });
  for (const { idx, members, cur } of baskets) {
    if (members.length > 0) {
      // data exists -> the index is (or becomes) live; this is how OP/MTG indices light up post-discovery.
      // A catalog-GATED tier (sealed) is built + listed but never auto-flipped tradeable: an operator lists it.
      await buildIndex(db, idx, members, cur, passObservedAt, pinned);
      indices++;
    } else if (!idx.tradeable) {
      // No data this pass for a catalog-gated tier: make sure it's listed (inserted untradeable if new) but NEVER
      // downgrade one that's already live — an empty pass (e.g. every card of a game stale for 36h) must not flip a
      // live index untradeable, which would drop its open positions out of the liquidation sweep. A live index with
      // no fresh data goes stale and is halted (reduce-only) by haltStaleMarkets instead, like any market.
      await db.tx((q) => upsertIndexMarket(q, { game: idx.game, slug: idx.slug, name: idx.name, tradeable: 'keep' }));
    }
    // catalog-tradeable with a transiently empty pass: leave the live market untouched (staleness covers it)
  }
  return { cards: priced.length, indices, graded: gradedTotal };
}

/** Replace an index's constituent snapshot (one multi-row INSERT) — the basket + prices the next pass chains
 *  off. The live ingest and the history rebuild both write it through here. */
export async function writeIndexSnapshot(q: Queryer, marketId: string, members: ConstituentPrice[]): Promise<void> {
  await q.query(`DELETE FROM index_constituents WHERE market_id = $1`, [marketId]);
  if (!members.length) return;
  const params: unknown[] = [];
  const rows = members.map((m) => {
    params.push(randomUUID(), marketId, m.cardId, m.priceE6.toString());
    return `($${params.length - 3}, $${params.length - 2}, $${params.length - 1}, $${params.length})`;
  });
  await q.query(`INSERT INTO index_constituents(id, market_id, card_id, weight_e6) VALUES ${rows.join(', ')}`, params);
}

async function buildIndex(
  db: Db,
  idx: { game: string; slug: string; name: string; weighting?: string; capBps?: number; gated?: boolean },
  members: ConstituentPrice[],
  cur: Map<string, bigint>,
  observedAt: Date,
  pinned: Set<string>,
): Promise<void> {
  if (members.length === 0) return;
  const marketId = await db.tx((q) =>
    upsertIndexMarket(q, { game: idx.game, slug: idx.slug, name: idx.name, tradeable: idx.gated ? 'keep' : true }),
  );
  if (pinned.has(marketId)) return; // operator-pinned manual price — leave it alone

  // One chain link off the previous print + the previous basket snapshot (index-weighting.ts): GJ = Σ-price
  // ratio (Dutot — the correct divisor adjustment across rebalances), G&P = geometric mean (Jevons),
  // Pokedaq = capped weights. Leavers count; outliers are left out of the pass.
  const snap = await db.query<{ card_id: string; p: string }>(
    `SELECT card_id, weight_e6::text AS p FROM index_constituents WHERE market_id=$1`,
    [marketId],
  );
  const prevRow = await db.query<{ v: string }>(
    `SELECT index_price_e6::text AS v FROM oracle_prices WHERE market_id=$1 AND is_accepted ORDER BY source_observed_at DESC LIMIT 1`,
    [marketId],
  );
  const weighting = weightingOf(idx);
  const step = chainStep(
    prevRow.rows[0] ? BigInt(prevRow.rows[0].v) : 0n,
    new Map(snap.rows.map((r) => [r.card_id, BigInt(r.p)])),
    cur,
    weighting,
    { outlierFactor: config.indexOutlierFactor, capBps: idx.capBps ?? DEFAULT_CAP_BPS },
  );
  const indexValueE6 = step.levelE6;
  // Snapshot constituents (the previous-price input the next pass chains off) and record the level in ONE
  // transaction: split, a crash between them would chain the old level off the new snapshot (a lost pass move).
  const recorded = await db.tx(async (q) => {
    await writeIndexSnapshot(q, marketId, members);
    return recordOracle(q, marketId, indexValueE6, observedAt, {
      kind: 'index',
      method: weighting,
      constituents: members.length,
      used: step.used,
      missing: step.missing,
      outliers: step.outliers,
    });
  });
  if (recorded) {
    const market = await getMarketById(db, marketId);
    if (market) await db.tx((q) => recomputeMark(q, market, indexValueE6, 0n, 0n));
  }
}

/**
 * Cards whose price is FRESH enough to sit in an index: a featured market with an accepted print inside
 * INDEX_FRESH_MS (defaults to ORACLE_STALE_MS — the window haltStaleMarkets halts trading on) that an operator
 * hasn't halted/delisted. Run after this pass's card prints, so a card refreshed this pass counts. A print is
 * written when the provider's freshness timestamp advances or the price moves (recordOracle dedup) — so this drops
 * cards whose provider stopped refreshing them, e.g. tcgpl single listings that never change (measured: 120 of 232
 * featured MTG cards had one print, ever), which would otherwise flatten the index. Such cards are halted for
 * trading by the same rule. (Discovery's liquidity gate keeps them out of the featured set to begin with.)
 */
async function indexEligibleCardIds(db: Db): Promise<Set<string>> {
  const r = await db.query<{ card_id: string }>(
    `SELECT DISTINCT m.card_id FROM markets m
      WHERE m.kind = 'card' AND m.featured AND m.status NOT IN ('halted', 'delisted') AND m.card_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM oracle_prices o WHERE o.market_id = m.id AND o.is_accepted
                      AND o.ingested_at > now() - ($1 || ' milliseconds')::interval)`,
    [String(config.indexFreshMs)],
  );
  return new Set(r.rows.map((x) => x.card_id));
}

