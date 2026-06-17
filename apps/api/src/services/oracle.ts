import { randomUUID } from 'node:crypto';
import { toE6, SCALE } from '@pokex/pricing';
import { INDEX_CATALOG } from '@pokex/shared-types';
import { config } from '../config.ts';
import type { Db, Queryer } from '../db/client.ts';
import { upsertCardMarket, upsertIndexMarket, getMarketById, type CardUpsert } from './markets.ts';
import { recomputeMark, getMarkClampBps } from './marks.ts';
import { pokemontcgFetcher } from './providers/pokemontcg.ts';
import { fetchTrackedCards } from './providers/tcgpricelookup.ts';
import { fetchScrydexTrackedCards } from './providers/scrydex.ts';

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
    featured: c.featured, // undefined keeps the stored flag (rebalanced by the discovery job)
  };
}

/** Returns the cards to ingest. Injectable for tests. */
export type CardFetcher = () => Promise<OracleCard[]>;

const BASE_VALUE_E6 = 1_000_000_000n; // indices start at 1000.000000 points
const REANCHOR_JUMP_FACTOR = 4n; // a 1-tick jump beyond this can only be a wrong-scale divisor, not a real basket move

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
export async function ingestCard(
  db: Db,
  c: OracleCard,
  fallbackObservedAt: Date,
  pinned?: Set<string>,
  extra?: Partial<CardUpsert>, // creation-time overrides (e.g. the P6 dollar-min-notional min qty)
): Promise<string> {
  const marketId = await db.tx((q) => upsertCardMarket(q, { ...toCardUpsert(c), ...extra }));
  if (pinned?.has(marketId)) return marketId; // manual override in effect — skip the auto print + mark
  const recorded = await db.tx((q) =>
    recordOracle(q, marketId, c.rawE6, c.observedAt ?? fallbackObservedAt, c.payload ?? null),
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
  // tcgpricelookup = the market row's flag, rebalanced only by the discovery job).
  const sorted = [...priced].sort((a, b) => (b.rawE6 > a.rawE6 ? 1 : b.rawE6 < a.rawE6 ? -1 : 0));
  const featuredByGame = new Map<string, OracleCard[]>();
  for (const c of sorted) {
    if (!c.featured) continue;
    const list = featuredByGame.get(c.game) ?? [];
    list.push(c); // sorted order is preserved — each game's list stays price-descending
    featuredByGame.set(c.game, list);
  }

  // Graded (PSA-10) prices for the top-N per game — powers the Graded index + per-card graded panel.
  // Providers that carry graded inline (tcgpricelookup, P3) need no extra fetch; the gradedFetcher
  // (JustTCG) is the fallback for cards without it.
  const gradedByGame = new Map<string, { cardId: string; priceE6: bigint }[]>();
  let gradedTotal = 0;
  for (const [game, cards] of featuredByGame) {
    const members: { cardId: string; priceE6: bigint }[] = [];
    for (const c of cards.slice(0, config.gradedConstituents)) {
      let gE6 = c.gradedE6 ?? null;
      if (gE6 == null && gradedFetcher) {
        const g = await gradedFetcher(c);
        if (g != null) gE6 = toE6(g); // non-positive values are dropped by the guard below
      }
      if (gE6 != null && gE6 > 0n) {
        await db.query(`UPDATE markets SET graded_psa10_e6=$1 WHERE card_id=$2 AND kind='card'`, [gE6.toString(), c.cardId]);
        members.push({ cardId: c.cardId, priceE6: gE6 });
      }
    }
    gradedByGame.set(game, members);
    gradedTotal += members.length;
  }

  let indices = 0;
  for (const idx of INDEX_CATALOG) {
    const inGame = featuredByGame.get(idx.game) ?? [];
    // Members by basket kind: top-N raw baskets slice the featured list; graded uses the PSA-10 set;
    // anything else (sealed) has NO data source yet and must stay gated regardless of raw members.
    const members =
      idx.slug === 'graded'
        ? (gradedByGame.get(idx.game) ?? [])
        : idx.topN != null
          ? inGame.slice(0, idx.topN).map((x) => ({ cardId: x.cardId, priceE6: x.rawE6 }))
          : [];
    if (members.length > 0) {
      // data exists -> the index is (or becomes) live; this is how OP/MTG indices light up post-discovery
      await buildIndex(db, idx, members, passObservedAt, pinned);
      indices++;
    } else if (!idx.tradeable) {
      // catalog-gated and still no data: keep it listed but gated
      await db.tx((q) => upsertIndexMarket(q, { game: idx.game, slug: idx.slug, name: idx.name, tradeable: false }));
    }
    // catalog-tradeable with a transiently empty pass: leave the live market untouched (staleness covers it)
  }
  return { cards: priced.length, indices, graded: gradedTotal };
}

async function buildIndex(
  db: Db,
  idx: { game: string; slug: string; name: string },
  members: { cardId: string; priceE6: bigint }[],
  observedAt: Date,
  pinned: Set<string>,
): Promise<void> {
  if (members.length === 0) return;
  const rawE6 = members.reduce((a, m) => a + m.priceE6, 0n);
  const marketId = await db.tx((q) => upsertIndexMarket(q, { game: idx.game, slug: idx.slug, name: idx.name, tradeable: true }));
  if (pinned.has(marketId)) return; // operator-pinned manual price — leave it alone

  // Divisor: based at BASE_VALUE on first build, then RE-BASED whenever the constituent set
  // changes so the index value is continuous across rebalances (composition shouldn't move it).
  const newSet = members.map((m) => m.cardId).sort().join(',');
  const oldRows = await db.query<{ card_id: string }>(`SELECT card_id FROM index_constituents WHERE market_id=$1`, [marketId]);
  const oldSet = oldRows.rows.map((r) => r.card_id).sort().join(',');
  const divRow = await db.query<{ d: string }>(
    `SELECT divisor_e6::text AS d FROM index_divisors WHERE market_id = $1`,
    [marketId],
  );
  // The divisor carries 6 fractional digits (the column is divisor_e6): value = rawE6 * SCALE / divisor.
  // Without the scale a sub-$1000 basket would truncate the divisor toward 0 and the index would jump.
  const anchorDivisor = (target: bigint) => {
    const d = (rawE6 * SCALE) / target; // solve  rawE6 * SCALE / d == target
    return d > 0n ? d : 1n; // floor only for the degenerate rawE6 == 0 basket
  };

  let divisor: bigint;
  if (!divRow.rows[0]) {
    divisor = anchorDivisor(BASE_VALUE_E6); // start the index at its base value (1000.000000)
    await db.query(
      `INSERT INTO index_divisors(market_id, divisor_e6, base_value_e6) VALUES($1, $2, $3)
       ON CONFLICT(market_id) DO NOTHING`,
      [marketId, divisor.toString(), BASE_VALUE_E6.toString()],
    );
  } else {
    divisor = BigInt(divRow.rows[0].d);
    const prevRow = await db.query<{ v: string }>(
      `SELECT index_price_e6::text AS v FROM oracle_prices WHERE market_id=$1 AND is_accepted ORDER BY source_observed_at DESC LIMIT 1`,
      [marketId],
    );
    const prevVal = prevRow.rows[0] ? BigInt(prevRow.rows[0].v) : 0n;
    // Re-anchor the divisor (keeping the print continuous) on a constituent-set change, and self-heal a
    // divisor persisted at the wrong scale: a legacy pre-SCALE row would compute a value ~1e6x off, a
    // jump REANCHOR_JUMP_FACTOR catches as impossible for a diversified basket.
    const candidateE6 = (rawE6 * SCALE) / divisor; // value if we kept the stored divisor
    const setChanged = oldSet !== '' && oldSet !== newSet;
    const wrongScale = candidateE6 > prevVal * REANCHOR_JUMP_FACTOR;
    if (prevVal > 0n && (setChanged || wrongScale)) {
      divisor = anchorDivisor(prevVal);
      await db.query(`UPDATE index_divisors SET divisor_e6=$1, as_of=now() WHERE market_id=$2`, [divisor.toString(), marketId]);
    }
  }
  const indexValueE6 = (rawE6 * SCALE) / divisor;

  // Snapshot constituents (transparency / future rebalancing).
  await db.tx(async (q) => {
    await q.query(`DELETE FROM index_constituents WHERE market_id = $1`, [marketId]);
    for (const m of members) {
      await q.query(
        `INSERT INTO index_constituents(id, market_id, card_id, weight_e6) VALUES($1, $2, $3, $4)`,
        [randomUUID(), marketId, m.cardId, m.priceE6.toString()],
      );
    }
  });

  const recorded = await db.tx((q) =>
    recordOracle(q, marketId, indexValueE6, observedAt, { kind: 'index', constituents: members.length }),
  );
  if (recorded) {
    const market = await getMarketById(db, marketId);
    if (market) await db.tx((q) => recomputeMark(q, market, indexValueE6, 0n, 0n));
  }
}
