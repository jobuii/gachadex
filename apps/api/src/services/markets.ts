import { randomUUID } from 'node:crypto';
import { config } from '../config.ts';
import type { Db, Queryer } from '../db/client.ts';
import { usdc } from '../money.ts';
import { getFeeBps, getFundingFactorBps } from './fees.ts';
import { gradeLadder, sortGradeRows, type GradeRow } from './providers/tcgpricelookup.ts';
import type { ProductType } from './product-type.ts';
import { normVariant } from './providers/backfill.ts';

// Per-side open-interest caps (risk parameters). Indices are diversified -> deeper books.
const CARD_OI_CAP = usdc(50_000).toString();
const INDEX_OI_CAP = usdc(250_000).toString();

/** Market row with all BIGINT columns surfaced as decimal strings. */
export interface MarketRow {
  id: string;
  kind: 'card' | 'index';
  game: string;
  symbol: string;
  display_name: string;
  card_id: string | null;
  variant: string | null;
  printing: string | null; // the variant as a key (normVariant); with tcgplayer_id, the market's identity (one per pair)
  tcgplayer_id: string | null;
  index_slug: string | null;
  image_small: string | null;
  set_logo: string | null;
  status: string;
  tradeable: boolean;
  max_leverage_e2: number;
  init_margin_bps: number;
  maint_margin_bps: number;
  max_oi_long_uusdc: string;
  max_oi_short_uusdc: string;
  skew_k_e6: string;
  premium_cap_e6: string;
  max_dev_bps: number;
  min_qty_e6: string;
  qty_step_e6: string;
  price_tick_e6: string;
  price_pinned: boolean;
  low_confidence: boolean;
  mark_clamped: boolean; // mark guard engaged right now (§6a) — the prior-state input to recomputeMark's clamp
  featured: boolean;
  requires_scrydex: boolean; // priced only by Scrydex (JP + Scrydex-only EN) → hidden until ORACLE_PRIMARY=scrydex
  rarity: string | null; // metadata->>'rarity' — surfaced for the screener's Rarity column/filter
  jpy: boolean; // Japanese-market card (the JPY>$threshold set) — drives the screener/sidebar JPY toggle
}

const COLS = `id, kind, game, symbol, display_name, card_id, variant, printing, tcgplayer_id::text AS tcgplayer_id, index_slug, image_small, set_logo, status, tradeable,
  max_leverage_e2, init_margin_bps, maint_margin_bps,
  max_oi_long_uusdc::text AS max_oi_long_uusdc, max_oi_short_uusdc::text AS max_oi_short_uusdc,
  skew_k_e6::text AS skew_k_e6, premium_cap_e6::text AS premium_cap_e6, max_dev_bps,
  min_qty_e6::text AS min_qty_e6, qty_step_e6::text AS qty_step_e6, price_tick_e6::text AS price_tick_e6, price_pinned, low_confidence, mark_clamped, featured, requires_scrydex, jpy,
  metadata->>'rarity' AS rarity`;

export async function getMarketById(q: Queryer, id: string): Promise<MarketRow | null> {
  const r = await q.query<MarketRow>(`SELECT ${COLS} FROM markets WHERE id = $1`, [id]);
  return r.rows[0] ?? null;
}

export interface CardUpsert {
  game?: string; // 'pokemon' | 'onepiece' | 'mtg' (defaults to pokemon)
  symbol: string;
  cardId: string;
  displayName: string;
  variant: string | null;
  imageSmall: string | null;
  imageLarge?: string | null;
  setLogo?: string | null;
  metadata?: unknown;
  // Stable cross-provider identity (see schema). Optional: the legacy pokemontcg feed doesn't know
  // them; tcgpricelookup supplies both. Never erased on re-upsert (COALESCE keeps the stored value).
  tcgplayerId?: number | null;
  providerCardId?: string | null;
  // Index-constituent eligibility (the discovery featured set: top 400 singles + top 250 sealed per game, D10). Omit to keep the stored value.
  featured?: boolean | null;
  // single | sealed | other (product-type.ts) — from the provider's structured fields. Omit to keep the stored value.
  productType?: ProductType | null;
  // Creation-only: the per-market quantity floor (a fine step; the $1 dollar dust floor is the
  // engine's min-notional check). Never touched on re-upsert — the operator may retune a live market's min.
  minQtyE6?: bigint | null;
  // PSA-10 graded price (micro-USD), Scrydex-first / tcgpl fallback. Persisted on every print so the
  // detail-panel + Graded index stay current (incl. via the webhook); COALESCEd so a null never clobbers.
  gradedE6?: bigint | null;
  // Scrydex identity, set atomically when a market is listed/priced via Scrydex (so the oracle can anchor
  // it on Scrydex and the webhook can scope it). COALESCEd: a null never erases a stored id, so the
  // regular oracle pass (which doesn't echo them) keeps the backfilled values.
  scrydexCardId?: string | null;
  scrydexExpansionId?: string | null;
}

/** ORDER BY for "the product's main market" among its printing markets (P5): live first, then featured, then the
 *  oldest — wherever a lookup by product or Scrydex card could match several printings. */
export const MAIN_MARKET_ORDER = "(status = 'delisted'), featured DESC, created_at, id";

/** Symbol for a provider-created card market: game-namespaced so provider ids can never collide across
 *  games or with the `INDEX:` namespace. Legacy pokemontcg markets keep their bare `c.id` symbols (the
 *  upsert key for the live feed) — cutover joins them via tcgplayer_id/provider_card_id, not symbol. */
export function cardSymbol(game: string, providerCardId: string): string {
  return `${game}:${providerCardId}`;
}

/** Run `fn` in one transaction tagged with WHO is changing `featured`: the featured_events trigger (schema.sql) records
 *  this source with each flip. The setting is transaction-local, so it can't leak to other queries on the connection. */
export async function withFeaturedSource<T>(db: Db, source: string, fn: (q: Queryer) => Promise<T>): Promise<T> {
  return db.tx(async (q) => {
    await q.query(`SELECT set_config('gachadex.featured_source', $1, true)`, [source]);
    return fn(q);
  });
}

export async function upsertCardMarket(q: Queryer, opts: CardUpsert): Promise<string> {
  const id = randomUUID();
  const meta = opts.metadata != null ? JSON.stringify(opts.metadata) : null;
  await q.query(
    `INSERT INTO markets(id, kind, game, symbol, display_name, card_id, variant, image_small, image_large, set_logo, metadata, tradeable,
       max_oi_long_uusdc, max_oi_short_uusdc, tcgplayer_id, provider_card_id, featured, min_qty_e6, graded_psa10_e6, scrydex_card_id, scrydex_expansion_id, product_type,
       printing)
     VALUES($1, 'card', $11, $2, $3, $4, $5, $6, $7, $8, $9, true, $10, $10, $12, $13, COALESCE($14, false), COALESCE($15, 100), $16, $17, $18, $19, $20)
     ON CONFLICT(symbol) DO UPDATE
       SET display_name = EXCLUDED.display_name, image_small = EXCLUDED.image_small, image_large = EXCLUDED.image_large,
           set_logo = EXCLUDED.set_logo, metadata = EXCLUDED.metadata,
           -- the printing follows the feed's name for it; a feed that can't tell this pass (Scrydex, no match) keeps it
           variant = COALESCE(EXCLUDED.variant, markets.variant), printing = COALESCE(EXCLUDED.printing, markets.printing),
           tcgplayer_id = COALESCE(EXCLUDED.tcgplayer_id, markets.tcgplayer_id),
           provider_card_id = COALESCE(EXCLUDED.provider_card_id, markets.provider_card_id),
           featured = COALESCE($14, markets.featured),
           graded_psa10_e6 = COALESCE($16, markets.graded_psa10_e6),
           scrydex_card_id = COALESCE(EXCLUDED.scrydex_card_id, markets.scrydex_card_id),
           scrydex_expansion_id = COALESCE(EXCLUDED.scrydex_expansion_id, markets.scrydex_expansion_id),
           product_type = COALESCE(EXCLUDED.product_type, markets.product_type)`,
    [
      id, opts.symbol, opts.displayName, opts.cardId, opts.variant, opts.imageSmall, opts.imageLarge ?? null,
      opts.setLogo ?? null, meta, CARD_OI_CAP, opts.game ?? 'pokemon', opts.tcgplayerId ?? null, opts.providerCardId ?? null,
      opts.featured ?? null, opts.minQtyE6?.toString() ?? null, opts.gradedE6?.toString() ?? null,
      opts.scrydexCardId ?? null, opts.scrydexExpansionId ?? null, opts.productType ?? null, normVariant(opts.variant),
    ],
  );
  const r = await q.query<{ id: string }>(`SELECT id FROM markets WHERE symbol = $1`, [opts.symbol]);
  return r.rows[0].id;
}

/** A new printing market (P5) takes the Scrydex card + expansion ids of a sibling printing on the same TCGplayer
 *  product — one Scrydex card record carries every printing — so the Scrydex pass prices it and its price alerts
 *  (keyed by expansion) re-price it. No provider call. A market that already has them is left alone. */
export async function copySiblingScrydexIds(q: Queryer, marketId: string): Promise<void> {
  await q.query(
    `UPDATE markets n SET scrydex_card_id = s.scrydex_card_id, scrydex_expansion_id = COALESCE(n.scrydex_expansion_id, s.scrydex_expansion_id)
       FROM (SELECT scrydex_card_id, scrydex_expansion_id FROM markets
              WHERE tcgplayer_id = (SELECT tcgplayer_id FROM markets WHERE id = $1) AND id <> $1 AND scrydex_card_id IS NOT NULL
              ORDER BY (scrydex_expansion_id IS NULL), id LIMIT 1) s
      WHERE n.id = $1 AND n.scrydex_card_id IS NULL`,
    [marketId],
  );
}

/** An index market's symbol. Pokémon keeps its original un-namespaced symbol (back-compat, preserves history);
 *  other games are namespaced so e.g. One Piece 'top-100' can't collide with Pokémon's. */
export function indexSymbol(game: string, slug: string): string {
  return game === 'pokemon' ? `INDEX:${slug}` : `INDEX:${game}:${slug}`;
}

export async function upsertIndexMarket(
  q: Queryer,
  // tradeable 'keep': insert untradeable, and NEVER overwrite on later passes — for catalog-gated tiers (sealed)
  // that the ingest builds but only an operator lists for trading.
  opts: { game: string; slug: string; name: string; tradeable: boolean | 'keep' },
): Promise<string> {
  const id = randomUUID();
  const symbol = indexSymbol(opts.game, opts.slug);
  const oi = INDEX_OI_CAP;
  await q.query(
    `INSERT INTO markets(id, kind, game, symbol, display_name, index_slug, tradeable,
       max_oi_long_uusdc, max_oi_short_uusdc, max_dev_bps)
     VALUES($1, 'index', $7, $2, $3, $4, $5, $6, $6, 1000)
     ON CONFLICT(symbol) DO UPDATE
       SET display_name = EXCLUDED.display_name,
           tradeable = CASE WHEN $8 THEN markets.tradeable ELSE EXCLUDED.tradeable END`,
    [id, symbol, opts.name, opts.slug, opts.tradeable === true, oi, opts.game, opts.tradeable === 'keep'],
  );
  const r = await q.query<{ id: string }>(`SELECT id FROM markets WHERE symbol = $1`, [symbol]);
  return r.rows[0].id;
}

/** Markets list for the API: latest mark + index + 24h change (off the marks series). */
export interface MarketView {
  id: string;
  kind: 'card' | 'index';
  game: string;
  symbol: string;
  displayName: string;
  cardId: string | null;
  variant: string | null; // the printing's provider name ('Reverse Holofoil', 'Foil'…) — the printing chip
  printing: string | null; // its key; markets with the same tcgplayerId and different printings are siblings (P5)
  tcgplayerId: string | null;
  indexSlug: string | null;
  imageSmall: string | null;
  setLogo: string | null;
  status: string;
  tradeable: boolean;
  maxLeverage: number;
  maintMarginBps: number;
  feeBps: number;
  fundingFactorBps: number; // operator-set max hourly funding rate at full skew; client scales by live skew
  qtyStepE6: string;
  minQtyE6: string;
  markE6: string | null;
  indexE6: string | null;
  change24hPct: number;
  pricePinned: boolean;
  restricted: boolean; // low price confidence -> reduce-only (no new positions); see priceCard
  markStabilizing: boolean; // §6a mark guard engaged: the mark is creeping toward an uncorroborated jump (price stabilizing)
  featured: boolean; // in the discovery featured set (top singles by price, D10: 400 per game) — the sidebar's default card list
  volume24hUsd: number; // 24h traded notional (USD) — the screener Volume column + Top-Volume sort
  rarity: string | null; // card rarity (from metadata) — the screener Rarity column + By-Rarity filter
  jpy: boolean; // Japanese-market card — the JPY on/off filter (default off: the main 250/game is English)
}

/** Per-market details (card metadata + graded prices) for the detail panel. */
export interface MarketDetails {
  displayName: string; // the card's display name (e.g. "Charizard δ (Dragon Frontiers) #100")
  imageLarge: string | null;
  setLogo: string | null;
  variant: string | null; // printing ('Standard', 'Holofoil', …) — the market row's own column
  metadata: unknown; // { setName, setSlug, rarity }
  gradedPsa10E6: string | null;
  grades: GradeRow[]; // full ladder from the latest provider print; [] until one carries graded data
  releaseYear: number | null; // the card's set release year (from the tcg_sets cache); null if unknown
}

export async function getMarketDetails(db: Db, id: string): Promise<MarketDetails | null> {
  // The latest accepted print's archived payload carries the provider's whole graded object (PSA/BGS/
  // CGC × grade); markets columns only persist the PSA-10 the graded index needs. Project just the
  // graded subtree — the full payload is the entire provider print. release_year joins the cached set
  // metadata by slug first (precise), falling back to game+name so already-listed markets resolve too.
  const [r, p] = await Promise.all([
    db.query<{ display_name: string; image_large: string | null; set_logo: string | null; variant: string | null; metadata: unknown; graded: string | null; release_year: number | null }>(
      `SELECT m.display_name, m.image_large, m.set_logo, m.variant, m.metadata, m.graded_psa10_e6::text AS graded,
              COALESCE(
                (SELECT release_year FROM tcg_sets WHERE game = m.game AND slug = m.metadata->>'setSlug'),
                (SELECT release_year FROM tcg_sets WHERE game = m.game AND name = m.metadata->>'setName' ORDER BY slug LIMIT 1)
              ) AS release_year
         FROM markets m WHERE m.id = $1`,
      [id],
    ),
    db.query<{ sx: unknown; tpl: unknown }>(
      // Latest accepted print carrying a graded ladder from each source. Scrydex (a pre-built GradeRow[])
      // is preferred; tcgpl's eBay graded object is the fallback (parsed via gradeLadder). Either query
      // alone never blanks the ladder if a later print (manual admin / legacy feed) lacks graded data.
      `SELECT
         (SELECT raw_payload #> '{scrydex,graded}' FROM oracle_prices WHERE market_id = $1 AND is_accepted
            AND raw_payload #> '{scrydex,graded}' IS NOT NULL ORDER BY source_observed_at DESC LIMIT 1) AS sx,
         (SELECT raw_payload #> '{tcgpricelookup,prices,graded}' FROM oracle_prices WHERE market_id = $1 AND is_accepted
            AND raw_payload #> '{tcgpricelookup,prices,graded}' IS NOT NULL ORDER BY source_observed_at DESC LIMIT 1) AS tpl`,
      [id],
    ),
  ]);
  const row = r.rows[0];
  if (!row) return null;
  const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata ?? null);
  const sxGraded = typeof p.rows[0]?.sx === 'string' ? JSON.parse(p.rows[0].sx as string) : p.rows[0]?.sx;
  const tplGraded = typeof p.rows[0]?.tpl === 'string' ? JSON.parse(p.rows[0].tpl as string) : p.rows[0]?.tpl;
  const grades = Array.isArray(sxGraded) && sxGraded.length ? sortGradeRows(sxGraded as GradeRow[]) : gradeLadder(tplGraded);
  return {
    displayName: row.display_name,
    imageLarge: row.image_large, setLogo: row.set_logo, variant: row.variant, metadata,
    gradedPsa10E6: row.graded, grades, releaseYear: row.release_year ?? null,
  };
}

/** Percentage change of `cur` vs a reference price (2 dp), or null when there's no reference (or it's 0).
 *  Shared by the 24h change + the index-overview windows so the rounding/guard stay identical. */
function pctChange(cur: bigint, ref: bigint | undefined): number | null {
  if (ref === undefined || ref === 0n) return null;
  return Math.round((Number(cur - ref) / Number(ref)) * 100 * 100) / 100;
}

export async function listMarketsWithData(db: Db): Promise<MarketView[]> {
  const markets = await db.query<MarketRow>(`SELECT ${COLS} FROM markets ORDER BY kind DESC, display_name`);

  const latest = await db.query<{ market_id: string; mark_e6: string; index_e6: string }>(
    `SELECT DISTINCT ON (market_id) market_id, mark_price_e6::text AS mark_e6, index_price_e6::text AS index_e6
     FROM marks ORDER BY market_id, computed_at DESC`,
  );
  const latestMap = new Map(latest.rows.map((r) => [r.market_id, r]));

  // 24h change, computed from the SAME mark series the chart + displayed price use (`marks` by
  // computed_at) — NOT oracle_prices by source_observed_at. The provider's source_observed_at can be
  // static/backdated, so that ordering disagreed with the marks the user actually sees and reported
  // 0% for cards whose chart had clearly moved. Reference = the last mark at/before now-24h.
  const ref = await db.query<{ market_id: string; ref: string }>(
    `SELECT DISTINCT ON (market_id) market_id, mark_price_e6::text AS ref
     FROM marks WHERE computed_at <= now() - interval '24 hours'
     ORDER BY market_id, computed_at DESC`,
  );
  const changeMap = new Map<string, number>();
  for (const r of ref.rows) {
    const cur = latestMap.get(r.market_id)?.mark_e6;
    const ch = cur ? pctChange(BigInt(cur), BigInt(r.ref)) : null;
    if (ch !== null) changeMap.set(r.market_id, ch);
  }

  // 24h traded notional (USD) per market — same qty×price/1e12 as the candle volume — for the
  // screener's Volume column + Top-Volume sort. Markets with no fills in the window default to 0.
  const vol = await db.query<{ market_id: string; vol: number }>(
    `SELECT market_id, (sum(qty_e6::numeric * exec_price_e6::numeric) / 1000000000000)::float8 AS vol
       FROM fills WHERE created_at > now() - interval '24 hours' GROUP BY market_id`,
  );
  const volMap = new Map(vol.rows.map((r) => [r.market_id, Number(r.vol)]));

  // Scrydex-only markets (the JP set + Scrydex-only EN) have no mark under tcgpl-primary — hide them
  // until ORACLE_PRIMARY=scrydex, then they auto-reveal. config.oraclePrimary is read synchronously at boot.
  return markets.rows
    .filter((m) => !m.requires_scrydex || config.oraclePrimary === 'scrydex')
    .map((m) => {
      const l = latestMap.get(m.id);
      return {
        id: m.id,
        kind: m.kind,
        game: m.game,
        symbol: m.symbol,
        displayName: m.display_name,
        cardId: m.card_id,
        variant: m.variant,
        printing: m.printing,
        tcgplayerId: m.tcgplayer_id,
        indexSlug: m.index_slug,
        imageSmall: m.image_small,
        setLogo: m.set_logo,
        status: m.status,
        tradeable: m.tradeable,
        maxLeverage: Math.round(m.max_leverage_e2 / 100),
        maintMarginBps: m.maint_margin_bps,
        feeBps: getFeeBps(), // live trading fee (same global knob for every market); lets clients preview the real fee
        fundingFactorBps: getFundingFactorBps(), // live funding factor; the client estimates the rate from live OI skew
        qtyStepE6: m.qty_step_e6,
        minQtyE6: m.min_qty_e6,
        markE6: l?.mark_e6 ?? null,
        indexE6: l?.index_e6 ?? null,
        change24hPct: changeMap.get(m.id) ?? 0,
        pricePinned: m.price_pinned,
        restricted: m.low_confidence,
        markStabilizing: m.mark_clamped, // §6a mark guard engaged — show the "price stabilizing" badge
        featured: m.featured,
        volume24hUsd: volMap.get(m.id) ?? 0,
        rarity: m.rarity,
        jpy: m.jpy,
      };
    });
}

export interface IndexOverviewRow {
  marketId: string;
  change1wPct: number | null; // null = the index is younger than the window (not enough history)
  change1mPct: number | null;
  changeYtdPct: number | null; // an index launched this year has YTD = since-launch (correct year-to-date)
  high52wE6: string | null; // high/low over AVAILABLE history (<= 1y), micro-USD; full-year once it accrues
  low52wE6: string | null;
  // index rules v3: the basket has an open member list (else the old every-pass top-N), and its next announced change
  governed: boolean;
  nextChange: { changeDate: string; effectiveAt: string; adds: number; removes: number } | null;
}

/** Time-windowed stats for the Markets "Indices" overview table — per index market: 1w / 1m / YTD % change
 *  plus the 52-week high/low, all from the same `marks` series the chart + 24h change use. Indices are few,
 *  so this is a handful of cheap indexed queries, run on demand when the Indices sub-tab opens. Current price
 *  + 24h change still come from the live /markets feed; this only adds the slower-moving windows. */
export async function indexOverview(db: Db): Promise<IndexOverviewRow[]> {
  const J = `JOIN markets m ON m.id = mk.market_id AND m.kind = 'index'`;
  // the last mark at/before a cutoff, per index — same reference logic as the 24h change
  const refAt = async (cutoffSql: string): Promise<Map<string, bigint>> => {
    const r = await db.query<{ market_id: string; v: string }>(
      `SELECT DISTINCT ON (mk.market_id) mk.market_id, mk.mark_price_e6::text AS v
         FROM marks mk ${J} WHERE mk.computed_at <= ${cutoffSql}
         ORDER BY mk.market_id, mk.computed_at DESC`,
    );
    return new Map(r.rows.map((x) => [x.market_id, BigInt(x.v)]));
  };

  const [latest, earliest, ref1w, ref1m, refYtd, hl, rules] = await Promise.all([
    db.query<{ market_id: string; v: string }>(
      `SELECT DISTINCT ON (mk.market_id) mk.market_id, mk.mark_price_e6::text AS v
         FROM marks mk ${J} ORDER BY mk.market_id, mk.computed_at DESC`),
    db.query<{ market_id: string; v: string }>(
      `SELECT DISTINCT ON (mk.market_id) mk.market_id, mk.mark_price_e6::text AS v
         FROM marks mk ${J} ORDER BY mk.market_id, mk.computed_at ASC`),
    refAt(`now() - interval '7 days'`),
    refAt(`now() - interval '30 days'`),
    refAt(`date_trunc('year', now())`),
    db.query<{ market_id: string; hi: string; lo: string }>(
      `SELECT mk.market_id, max(mk.mark_price_e6)::text AS hi, min(mk.mark_price_e6)::text AS lo
         FROM marks mk ${J} WHERE mk.computed_at >= now() - interval '365 days'
         GROUP BY mk.market_id`),
    // index rules v3, per index market via its basket ('game:tier'; the gp-/pdq- slug prefixes are INDEX_SERIES'):
    // an open member list? + the earliest pending change (the one applyIfDue applies next)
    db.query<{ id: string; governed: boolean; change_date: string | null; effective_at: Date | null; adds: number | null; removes: number | null }>(
      `SELECT m.id, EXISTS (SELECT 1 FROM index_members im WHERE im.basket = b.k AND im.left_at IS NULL) AS governed,
              c.change_date::text, c.effective_at, cardinality(c.adds) AS adds, jsonb_array_length(c.removes) AS removes
         FROM markets m
        CROSS JOIN LATERAL (SELECT m.game || ':' || regexp_replace(m.index_slug, '^(gp|pdq)-', '') AS k) b
         LEFT JOIN LATERAL (SELECT * FROM index_changes c WHERE c.basket = b.k AND c.applied_at IS NULL AND NOT c.cancelled
                             ORDER BY c.change_date LIMIT 1) c ON true
        WHERE m.kind = 'index'`),
  ]);

  const rulesMap = new Map(rules.rows.map((r) => [r.id, {
    governed: r.governed,
    nextChange: r.change_date ? { changeDate: r.change_date, effectiveAt: new Date(r.effective_at!).toISOString(), adds: Number(r.adds), removes: Number(r.removes) } : null,
  }]));
  const curMap = new Map(latest.rows.map((r) => [r.market_id, BigInt(r.v)]));
  const firstMap = new Map(earliest.rows.map((r) => [r.market_id, BigInt(r.v)]));
  const hlMap = new Map(hl.rows.map((r) => [r.market_id, { hi: r.hi, lo: r.lo }]));

  return [...curMap.entries()].map(([marketId, cur]) => {
    const hilo = hlMap.get(marketId);
    // YTD ref = last mark before Jan 1; an index launched this year has none, so fall back to its earliest
    // mark — YTD then = since-launch, which IS the correct year-to-date for a mid-year listing.
    const ytdRef = refYtd.get(marketId) ?? firstMap.get(marketId);
    return {
      marketId,
      change1wPct: pctChange(cur, ref1w.get(marketId)),
      change1mPct: pctChange(cur, ref1m.get(marketId)),
      changeYtdPct: pctChange(cur, ytdRef),
      high52wE6: hilo?.hi ?? null,
      low52wE6: hilo?.lo ?? null,
      ...(rulesMap.get(marketId) ?? { governed: false, nextChange: null }),
    };
  });
}

export interface Candle {
  time: number; // UTC unix seconds (bucket start)
  value: number; // = close (back-compat: line/area/baseline read this)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number; // traded notional (USD) in the bucket; 0 when nothing traded
}

/**
 * Real price history for the chart, from the `marks` series. Buckets are intraday (hourly) for short
 * windows and daily for longer ones; each bucket's value is its last mark (the close). NO synthetic /
 * fabricated data — the only non-mark series is the provider-seeded PRE-listing history (chart_seed),
 * which renders strictly before the market's first real mark; marks always win from then on.
 */
export async function getCandles(db: Db, marketId: string, days: number): Promise<Candle[]> {
  const bucket = days <= 7 ? 'hour' : 'day'; // intraday for 1D/1W, daily for 1M+
  // Seeded days are capped at the day BEFORE the first mark, so the two series can never collide on
  // a bucket (lightweight-charts requires strictly ascending times). Every date cast is pinned to
  // UTC like the mark buckets are — a non-UTC session TimeZone must not shift the cutoff day.
  // price_e6 > 0 drops the "provider had no history" sentinel rows.
  const r = await db.query<{ t: string; o: string; h: string; l: string; c: string }>(
    `SELECT t::text AS t, o::text AS o, h::text AS h, l::text AS l, c::text AS c FROM (
       SELECT extract(epoch FROM date_trunc($3, computed_at AT TIME ZONE 'UTC'))::bigint AS t,
              (array_agg(mark_price_e6 ORDER BY computed_at ASC))[1] AS o,  -- open  = first mark in the bucket
              max(mark_price_e6) AS h,                                       -- high
              min(mark_price_e6) AS l,                                       -- low
              (array_agg(mark_price_e6 ORDER BY computed_at DESC))[1] AS c   -- close = last mark
         FROM marks WHERE market_id = $1 AND computed_at > now() - ($2 || ' days')::interval
        GROUP BY 1
       UNION ALL
       -- seeded pre-listing days are a single daily price → flat OHLC
       SELECT extract(epoch FROM day::timestamp)::bigint, price_e6, price_e6, price_e6, price_e6
         FROM chart_seed
        WHERE market_id = $1 AND price_e6 > 0
          AND day > ((now() AT TIME ZONE 'UTC') - ($2 || ' days')::interval)::date
          AND day < COALESCE(
                (SELECT (min(computed_at) AT TIME ZONE 'UTC')::date FROM marks WHERE market_id = $1),
                'infinity'::date)
     ) series ORDER BY t`,
    [marketId, String(days), bucket],
  );
  // Traded volume (USD notional) per bucket, from fills — same UTC bucketing as the candles.
  const vol = await db.query<{ t: string; usd: string }>(
    `SELECT extract(epoch FROM date_trunc($3, created_at AT TIME ZONE 'UTC'))::bigint::text AS t,
            (sum(qty_e6::numeric * exec_price_e6::numeric) / 1000000000000)::text AS usd
       FROM fills WHERE market_id = $1 AND created_at > now() - ($2 || ' days')::interval
      GROUP BY 1`,
    [marketId, String(days), bucket],
  );
  const volByT = new Map(vol.rows.map((v) => [v.t, Number(v.usd)]));
  return r.rows.map((row) => {
    const e6 = (s: string) => Number(s) / 1_000_000;
    return {
      time: Number(row.t),
      value: e6(row.c),
      open: e6(row.o),
      high: e6(row.h),
      low: e6(row.l),
      close: e6(row.c),
      volume: volByT.get(row.t) ?? 0,
    };
  });
}
