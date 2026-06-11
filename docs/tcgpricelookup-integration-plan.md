# tcgpricelookup integration plan

Replace the pokemontcg.io (raw) + JustTCG (graded) feeds with **tcgpricelookup** (Trader plan) as the
primary price source, across **Pokémon + One Piece + MTG**, and add a **search-and-bet** feature so
users can trade any card, not just the featured top-250. Provider spec: `docs/data-providers.md`.

## Current state (already built — do NOT rebuild)

- **Game dimension is wired end-to-end:** `markets.game` ('pokemon'|'onepiece'|'mtg') + `idx_markets_game`
  (`schema.sql:140,171-172`), per-game `INDEX_CATALOG` (`packages/shared-types/src/index.js:22`), and the
  frontend **game-switcher** (`apps/web/src/components/SidebarMarkets.jsx`, `pages/Exchange.jsx`). Pokémon
  markets/indices are live; OP/MTG indices are listed but **gated** until card data lands.
- **Oracle today** runs on pokemontcg.io (raw, `oracle.ts:57`) + JustTCG (graded, `oracle.ts:39`),
  Pokémon-only, with `game:'pokemon'` hard-coded at `oracle.ts:132`.
- This plan is the **data-provider integration** (swap the feed to tcgpricelookup, light up OP/MTG card
  data, add search-and-bet). It does **not** re-do the game dimension or the frontend switcher.

## Constraints that shape the design (verified live 2026-06-11)

- **No price sort.** `search` filters by `q` / `game` / `set` only and returns results
  **alphabetically**; no-`q` browse returns the *whole* catalog (46,543 Pokémon cards, many null-priced).
  So we can't fetch "top-250 by price" in one call — the tracked universe must be a set **we maintain**.
- **Rate limit 1 req/s** (burst 1, `retry-after: 1`), Cloudflare-fronted; 10,000 requests/day (Trader).
- **Raw + graded come back together** in one card object — no separate graded round-trip needed.
- All USD. Card fields confirmed live: `id`, `tcgplayer_id`, `name`, `number`, `rarity`, `image_url`,
  `set.name`, `game.slug`, `prices.raw.<cond>.tcgplayer.{market,low,mid,high}`,
  `prices.raw.<cond>.ebay.{avg_1d,7d,30d}`, `prices.graded.<psa|bgs|cgc>.<grade>.ebay.{avg_1d,7d,30d}`.

## Architecture

1. **Normalize the oracle.** `ingest` (`oracle.ts:114`) is hard-wired to the pokemontcg shape
   (`getCardPrice`, `pickVariant`, `extractMetadata`, `game:'pokemon'` at line 132). Introduce a
   provider-agnostic type and have each fetcher emit it:
   ```ts
   interface OracleCard {
     game: 'pokemon' | 'onepiece' | 'mtg';
     cardId: string;            // provider id (stable market symbol)
     tcgplayerId?: number | null;
     displayName: string; number: string | null; rarity: string | null; setName: string | null;
     imageSmall: string | null; imageLarge: string | null;
     rawE6: bigint;             // raw NM market price (the tradeable spot)
     gradedE6: bigint | null;   // PSA-10 (ebay avg_7d), inline — no separate fetch
   }
   ```
   `ingest` consumes `OracleCard[]`; provider-specific extraction moves into each fetcher. Existing
   injectable-fetcher tests stay green.

2. **Provider fetchers** (all return `OracleCard[]`):
   - `tcgpricelookupFetcher(game)` — **primary**. Maps `raw.near_mint.tcgplayer.market → rawE6`,
     `graded.psa.10.ebay.avg_7d → gradedE6`.
   - `pokemontcgFetcher` (today's `fetchTopCards`) — Pokémon raw fallback.
   - JustTCG graded — fallback (kept).

3. **Tracked universe = the card markets.** Stable and **append-only** (a perps market must not vanish
   when a card's price rank drops). Two jobs:
   - **Refresh loop (frequent, ~daily):** fetch current prices for all tracked `card_id`s (batch
     ≤20/request if supported, else per-card), update raw + graded, recompute the Top-100/250 indices
     (top-N by price *of the tracked set*).
   - **Discovery job (periodic, ~weekly):** enumerate a game (no-`q`, paginate 100/page), filter to
     high-value (raw NM ≥ threshold), take the top ~250, **add** new cards as markets. Never removes.

## Feature 1 — Tracked universe: top-250 by price per game

- **Seed (one-time):** run discovery per game — crawl the catalog, keep priced cards, sort client-side,
  take the top 250. ~20 min one-time crawl across the 3 games at 1 req/s (background job, not the hot
  loop). Pokémon set gets re-derived on price (similar to today's pokemontcg top-250).
- The Top-100 / Top-250 indices are the existing divisor-based baskets (`buildIndex`), now computed
  from the tracked set per game.

## Feature 2 — Search & bet (on-demand markets)

Let users trade **any** card, not just the featured 250.

- **Search:** `GET /cards/search?q=&game=` (backend) → proxies tcgpricelookup search, **cached** by
  `(q, game)` for ~1h, **paced** at 1 req/s. Returns name, image, set, current raw price (+ graded).
- **Bet:** user picks a result → `POST /markets/ensure` (authed) with the provider card id → backend:
  if no market exists for that card, build one from the search result (it already carries the price),
  `upsertCardMarket`, mark it **tracked**, record the first oracle print + mark → returns the market id.
  Now tradeable; it joins the refresh loop and is priced daily thereafter.
- The universe grows organically with whatever users want to trade (the long tail).

## Phases

- **P1 — client + key + pacer.** tcgpricelookup HTTP client, `config.tcgpricelookupApiKey`
  (env `TCGPRICELOOKUP_API_KEY`, Railway only), a shared 1 req/s pacer + a small response cache.
  Confirm the batch-by-IDs format. Read-only, no behavior change.
- **P2 — normalize.** `OracleCard` type; refactor `ingest` to consume it; move pokemontcg extraction
  into `pokemontcgFetcher`. Tests stay green.
- **P3 — tcgpricelookup fetcher** (raw + graded inline), per game, with pacing + fallbacks kept.
- **P4 — discovery job** (enumerate + filter + add markets) for One Piece + MTG, plus Pokémon top-up.
- **P5 — cutover + monitor.** Switch the oracle loop to tcgpricelookup; pokemontcg/JustTCG stay fallback.
- **P6 — search & bet:** the search proxy (cached/paced) + `markets/ensure` on-demand creation + the
  frontend search-and-trade flow.

## Rate limits, caching, budget

- **Refresh:** ~750 tracked cards (250 × 3) via batch-of-20 ≈ 38 req (~40s/day). Per-card fallback ≈ 12
  min/day. Both far under 10,000/day.
- **Discovery:** ~1,400 pages full crawl (~23 min) — weekly background job.
- **Search (user-facing):** **must be cached** — cache `(q, game)` results (TTL ~1h) so repeat searches
  don't hit the API; the 1 req/s pacer serializes uncached calls. At self-test traffic this is fine; at
  scale, cache aggressively and/or move to the Business tier (100k/day, 3 req/s).

## Risk notes (long-tail markets)

**Decision (operator): all cards trade the same — up to 20x, no special tier.** On-demand long-tail
cards get the same leverage as the featured top-250. Accepted residual risk: low-value / illiquid card
markets at 20x lean entirely on the existing pool defenses (adaptive depth from NAV/cum-volume,
NAV-relative OI caps, the MAX_PNL_FACTOR open-gate + ADL). Those caps scale a market's risk to the pool
so a thin market self-limits — worth watching the adaptive-depth floor + OI-cap behavior for the long
tail once real volume exists.

## Config & secrets

- `TCGPRICELOOKUP_API_KEY` — Railway env only, **never** committed. `X-API-Key` header.
- `TCGPRICELOOKUP_BASE` = `https://api.tcgpricelookup.com/v1`.
- Reuse `gradedConstituents` for the graded index size; add a discovery price threshold + tracked-count
  per game.

## Testing

Keep the injectable-fetcher pattern: unit-test `ingest` with a fake `OracleCard[]` (no network); test the
tcgpricelookup mapper against a captured JSON fixture; test `markets/ensure` idempotency (same card →
same market, no double-create); test the search cache (second call doesn't hit the API).

---

# Adversarial review (2026-06-11) — gaps found + resolutions

A 4-angle adversarial pass against the live code. These resolutions are part of the plan; the phase
order below supersedes the P1–P6 list above.

## A. Migration foundation — stable cross-provider key (CRITICAL; blocks everything)

Markets are keyed on the provider's display id (`symbol = card.id`, `oracle.ts:134`; `ON CONFLICT(symbol)`
`markets.ts:67`); existing markets use pokemontcg ids; tcgpricelookup uses UUIDs; `tcgplayer_id` is stored
nowhere. As written, cutover INSERTs duplicate markets → old ones stale → positions freeze to
`reduce_only` (`engine.ts:764`); charts/indices (keyed on `market_id`) break. Resolutions:
- Add a stable join column to `markets` (`tcgplayer_id` + `provider_card_id`); **backfill** existing
  markets via pokemontcg `tcgplayer.productId` → tcgpricelookup `tcgplayer_id`. Key all upserts on the
  stable id, not the provider display id. Handle unmatchable markets explicitly (keep on the old feed).
- **Namespace card symbols by game** (`<game>:<id>`) so ids can't collide across games or with the
  `INDEX:*` namespace.
- `markets/ensure` resolves via the same stable id (so an existing card never gets a 2nd market).

## B. Separate the index basket from the tracked/priced universe (CRITICAL)

Today the index = `sorted.slice(0, topN)` of *everything ingested* (`oracle.ts:182-184`), so an
append-only + search-and-bet universe lets any user mutate the Top-100/250 basket and force a divisor
re-anchor. Resolution: two distinct sets.
- **Tracked/priced universe** — append-only, grows with search-and-bet; every member gets a daily print.
- **Index constituents** — the **featured discovery top-250 ONLY**, rebalanced *only* on the scheduled
  discovery job, explicitly excluding on-demand long-tail markets. Persist the featured flag on the market.

## C. Search-and-bet economic safety (CRITICAL — protects the LP pool)

The named long-tail defenses are wrong: the NAV gates default OFF, and adaptive depth doesn't constrain
oracle-driven PnL. The real attack is a manipulable first/ongoing oracle print on an attacker-chosen thin
card at 20x. Required controls (all of these, before search-and-bet ships):
- **First-print validation** on `markets/ensure`: require `tcgplayer.market` and `ebay.avg_7d` to both be
  present and agree within a tolerance; reject null/zero/one-sided. No unvalidated first print.
- **Smoothed oracle for low-liquidity cards:** price the market off `ebay.avg_7d` (a 7-day average a
  single relisting can't move), not the `tcgplayer.market` spot, below a liquidity threshold.
- **Mandatory NAV-relative gates:** ship with `oiCapNavBps`, `maxPnlFactorBps`, `adlPnlFactorBps` **set
  non-zero** (they default to 0 = off, `config.ts`). Add a boot assertion: on-demand markets enabled ⇒
  these must be > 0. The static `$50k` `CARD_OI_CAP` is NAV-unaware and not sufficient alone.
- **Creatability gate:** reject `markets/ensure` unless raw NM market ≥ a min-price threshold AND
  eBay agrees within X% (liquidity proxy). Reject sealed/null/un-repriceable cards.
- **Dollar-denominated min notional:** set `min_qty_e6` so the minimum order is a fixed $ floor, not a
  fixed unit count (a sub-dollar card otherwise has a near-zero economic floor).
- **Bound proliferation:** cap total tracked markets and/or per-user create rate; **auto-retire** markets
  with zero OI and no volume after N days (safe to relax append-only for empty markets).
- **Search firewall:** per-user/IP rate limit on `/cards/search` (reuse `routeRateLimits`); normalize the
  cache key (trim/lowercase/clamp offset) so it can't be bypassed; negative-result caching; a **separate
  request budget** for user search so it can never starve the oracle refresh.

## D. Reliability, rate-limit, budget, ops (CRITICAL)

- **Single-leader guard:** the oracle/discovery loops run in every instance (`index.ts:19-27`, no guard)
  but the app is multi-instance (`advisoryXactLock`) → N instances breach the global 1 req/s. Gate the
  oracle/discovery/search-budget behind a Postgres advisory leader lock (or a replica pin), and make the
  pacer a **DB-backed token bucket keyed on the API key**, not a per-process timer.
- **Priority queue, one limiter:** user search > refresh > discovery; discovery is chunked, low-priority,
  cancellable, and **resumable** (checkpoint by `offset`, single-flight via advisory lock).
- **Outage / throttle policy:** define the fallback trigger (N consecutive failures / HTTP class) and
  chain (tcgpricelookup → pokemontcg/scrydex raw → JustTCG graded); honor `retry-after` + exponential
  backoff with jitter on 429/Cloudflare; isolate per-card failures so one 429 doesn't abort the whole
  pass. Decide the stale-mark policy: tighten `oracleStaleMs` (36h today) for leverage safety, or halt
  opens on staleness rather than allowing 36h of trading on a frozen mark.
- **Budget accountant:** track requests-used-today vs 10k; reserve a per-consumer share; degrade
  gracefully at the cap (refresh open-interest-bearing markets first). Correct the budget math to the
  real **6h** refresh cadence (4×/day) and the unbounded append-only growth.
- **Monitoring:** budget-used %, error/429 rate, max feed staleness, fallback-active, discovery
  completion — surfaced like the custody ops runbook; alert thresholds.

## E. Data-field mapping precision

- **Price fallback chain (define exactly):** `raw.near_mint.tcgplayer.market` → `raw.near_mint.ebay.avg_7d`
  → next condition (`lightly_played`) → else ineligible. Many cards are null on the primary field.
- **Variant rule:** each tcgpricelookup `id` is a single variant. Decide: one market per variant (and a
  dedupe rule so one physical card ≠ multiple index slots), or pick a canonical variant. Map the provider
  `variant` into the column; retire `pickVariant`.
- **Wire the freshness gate:** carry the provider `updated_at` into `source_observed_at` (today it's
  wall-clock `new Date()`, `oracle.ts:120`), so dedup works AND `haltStaleMarkets` actually triggers on a
  stale provider price (today it keys on our write-time and never halts a weeks-old price).
- **Graded fallback:** `psa.10.ebay.avg_7d` → `avg_1d`/`avg_30d`; minimum-sample floor before a grade
  counts as a Graded-index member (else sparse data thrashes the divisor).
- **Discovery determinism:** per-game min-price threshold + tiebreaker (price desc, then `tcgplayer_id`)
  for a stable top-250.

## Cutover safety (folds into the revised P5)

- **Feature flag** `ORACLE_PRIMARY=tcgpricelookup|pokemontcg` — cutover/rollback is a config flip, not a
  deploy. Backfill is additive (new columns) so revert needs no destructive rewrite.
- **Shadow run:** ingest tcgpricelookup into a side channel / compare prints in logs for N days before
  promoting it to the mark path.
- **Outlier-guard bypass for the cutover batch:** the new feed's price differs from pokemontcg's per card
  (different methodology/variant), so cutover prints would trip the 60% guard and halt markets — seed each
  market's reference with the new value (or widen `OUTLIER_THRESHOLD` for the one cutover run).
- **Universe union:** the seed crawl must include every currently-live card market, not just a fresh
  top-250, so no live market drops out and freezes on day one.

## Revised phase order

- **P0 — Migration foundation:** stable provider-id column + backfill + game-namespaced symbols; feature
  flag; additive, no behavior change. *(Blocks all cutover.)*
  **STATUS: DONE (2026-06-11).** Shipped: `markets.tcgplayer_id` + `markets.provider_card_id` columns with
  partial UNIQUE indexes (the duplicate-market guard), `upsertCardMarket` persists them (COALESCE — a
  provider that doesn't know them never erases them), the `cardSymbol(game, id)` namespacing convention,
  and the validated `ORACLE_PRIMARY` flag (default `pokemontcg`). **Finding that adjusts P1:** pokemontcg's
  `tcgplayer` object has NO `productId` (only prices/updatedAt/url — verified live), so existing markets
  CANNOT be matched by tcgplayer id from our side; the backfill must match by **name + set + number** via
  the tcgpricelookup search API → the backfill script lands in **P1** (it needs the client), writing both
  ids onto matched markets via the now-existing write-path.
- **P1 — Client + key + global limiter:** tcgpricelookup client, `TCGPRICELOOKUP_API_KEY` (Railway env),
  DB-backed token bucket + leader guard + priority queue + retry/backoff. Confirm batch-by-IDs.
  **STATUS: DONE (2026-06-11).** Shipped: `services/providers/limiter.ts` (DB-backed global token bucket
  in the `provider_rate` table — N instances serialize to one provider-paced stream and share one daily
  budget; in-process priority queue search > refresh > discovery with per-tier daily ceilings
  100%/90%/60% so background work can't starve user search), `services/providers/tcgpricelookup.ts`
  (typed client: search / batch-by-ids / card details; every attempt re-claims a limiter slot; retries
  429 honoring retry-after + 5xx + Cloudflare HTML challenges with exp backoff + jitter; non-retryable
  4xx throws immediately), and the conservative name+number+set backfill
  (`services/providers/backfill.ts` + `scripts/backfill-provider-ids.ts`, dry-run by default,
  idempotent, unique-violation→'conflict' report). Config: `TCGPRICELOOKUP_API_KEY/_BASE/
  _MIN_INTERVAL_MS` (1100ms default)/`_DAILY_CAP`. **Verified live:** batch is
  `GET /cards/search?ids=a,b` (≤20); `tcgplayer_id` serializes as a STRING; one paced request through
  the real limiter returned raw + graded + ids. **Deliberate deferrals:** the loop leader guard lands
  with the loop wiring (P3/P5 — the DB bucket already makes rate limits multi-instance-safe; the guard
  only prevents duplicate WORK); the response cache lands with its consumer (the P6 search proxy).
  **Backfill execution** (against the prod DB, ~5 min at 1 req/s) is an ops step at P5 cutover prep.
- **P2 — Normalize:** `OracleCard` type with the price fallback chain + variant rule + provider
  `updated_at` as the observed timestamp; refactor `ingest`; pokemontcg extraction → its fetcher.
  **STATUS: DONE (2026-06-11).** `OracleCard` + `CardFetcher` in oracle.ts; `ingest` is fully
  provider-agnostic (game, symbol, ids, metadata, payload all come from the card); pokemontcg extraction
  lives in `services/providers/pokemontcg.ts` (`fromPokemontcg` mapper + `pokemontcgFetcher`); the
  JustTCG `GradedFetcher` takes an `OracleCard` and runs only when a card has no inline `gradedE6`.
  Per-card `observedAt` flows into `source_observed_at`. **Deliberate nuance:** the pokemontcg mapper
  leaves `observedAt` unset (ingest wall-clock), preserving the live feed's print cadence exactly —
  the tcgpricelookup fetcher (P3) is the one that sets provider `updated_at`. The price fallback chain
  + variant rule are tcgpricelookup-mapper concerns and land in P3 with it. End-to-end test proves a
  provider-built card flows: ids → markets, inline graded without a fetcher, provider timestamp → print.
- **P3 — tcgpricelookup fetcher** (raw + graded inline) per game, behind the flag, fallbacks kept.
  **Sequencing constraint:** the index/graded baskets are still single-game (`ingest` sorts the whole
  pass — see the SINGLE-GAME ASSUMPTION comment in oracle.ts). The cutover flag must NOT flip a
  multi-game feed live before P4's per-game featured-constituent separation lands.
  **STATUS: DONE (2026-06-11).** Shipped in `providers/tcgpricelookup.ts`: `rawPriceUsd` (the section-E
  fallback chain — NM tcgplayer.market when ≥ the $25 liquidity threshold, else the smoothed eBay
  avg_7d, else the spot, else lightly_played, else ineligible), `gradedPsa10Usd` (avg_7d → 1d → 30d),
  `fromTplCard` (identity ALWAYS from the tracked market row — game/symbol/card_id are ours; prices/
  images/freshness are the provider's; `updated_at` → observedAt for print dedup + staleness), and
  `fetchTrackedCards(db)` (batch-fetch every tracked `provider_card_id` via getCardsByIds at 'refresh'
  priority). `ingest` selects the fetcher by `ORACLE_PRIMARY` (`primaryFetcher`) — pokemontcg remains
  the default; the flag is still inert in prod. Tests prove the cutover invariant end-to-end: a
  backfilled legacy market re-prices IN PLACE (same row, no twin) with the provider timestamp on the
  print, and the flag test proves routing. Leader guard intentionally lands at P5 with cutover
  hardening (the DB token bucket already makes the rate limit multi-instance-safe; with provider
  observedAt, duplicate ingests also dedup at the print level — duplicate work only costs budget).
- **P4 — Discovery job** (resumable, single-flight, low priority) → featured top-250 per game; index
  constituents = featured set only.
  **STATUS: DONE (2026-06-11).** Shipped: `markets.featured` column (write-path keeps the stored flag
  unless a provider supplies it; pokemontcg marks its curated top-250 featured; tcgpricelookup reads the
  row's flag). **Index baskets are now PER-GAME and FEATURED-ONLY** — the single-game assumption is
  gone: a long-tail card can never enter a basket (proven by test: a pricier non-featured card stays
  out), OP/MTG indices auto-light when their featured cards get priced, Sealed stays gated (no data
  source), and a catalog-tradeable index with a transiently empty pass is left untouched (no downgrade).
  `providers/discovery.ts` + `scripts/discover-featured.ts`: resumable catalog crawl (checkpoints
  {offset, kept} into settings every 20 pages AND on failure — a budget refusal resumes where it
  stopped), deterministic top-N (price desc → tcgplayer id → provider id), 'discovery' priority
  (always preempted, first to yield budget), dry-run default with the completed crawl reused by a
  follow-up --apply, existing markets keep their identity (no twins), drop-outs lose `featured` but
  stay tracked+priced (append-only universe). **Single-flight** = ops discipline for now (operator-run
  script); the weekly recurring loop + leader guard land at P5. **Sequencing:** pokemon discovery-apply
  only at cutover (pre-cutover the live pokemontcg feed re-stamps its own featured set and they'd
  fight); OP/MTG any time.
- **P5 — Cutover:** shadow run → flag flip → outlier-guard bypass → universe union → monitor + rollback.
  Also at P5: (a) **frontend detail panel** — the uniform metadata ({setName, rarity}) replaces Pokémon
  hp/retreat/attacks; OrderEntry.jsx renders the Retreat row whenever metadata is truthy, so it would show
  "Retreat 0" on every card post-cutover — drop hp/retreat/attacks rows, render rarity. (b) **leader
  guard** for the oracle/discovery loops (duplicate work only costs budget; rate is already safe).
  (c) log tracked ids absent from the provider response (silent until the staleness halt otherwise).
- **P6 — Search-and-bet:** search firewall + creatability gate + first-print validation + smoothed oracle
  + dollar min-notional + market cap/retirement + **mandatory NAV gates on**. Ships last, after the core
  feed is proven.

---

# Decisions & defaults (operator-acknowledged 2026-06-11)

Locked-in choices and the concrete defaults a builder should use unless the operator overrides them.

- **Leverage:** all cards trade the same — **up to 20x**, no per-market tier. (See "Risk notes".)
- **Provider:** tcgpricelookup **Trader plan is purchased and active**; the operator supplies the key out
  of band. It lives only in Railway env `TCGPRICELOOKUP_API_KEY` (never committed). scrydex stays the raw
  fallback, JustTCG the graded fallback.
- **Pool-protection gates — MANDATORY, operator acknowledged off-by-default.** The operator has
  acknowledged that `oiCapNavBps`, `maxPnlFactorBps`, `adlPnlFactorBps` default to `0` (off), that this is
  the same uncapitalized-pool risk as the LP discussion, and that **they must be set non-zero before
  search-and-bet ships, and should be on for real funds regardless.** Recommended starting values
  (calibration in `docs/liquidity-calibration.md`), set as Railway env:
  - `MAX_PNL_FACTOR_BPS` ≈ **5500** (pause new opens at ~55% of NAV owed to winners)
  - `ADL_PNL_FACTOR_BPS` ≈ **7500** (auto-deleverage at ~75% of NAV)
  - `OI_CAP_NAV_BPS` ≈ **4000** (one side's OI ≤ ~0.4× NAV)
  - P6 boot assertion: on-demand markets enabled ⇒ all three must be > 0, else refuse to start.
- **Creatability gate (P6 default):** a searched card is tradeable only if `raw.near_mint.tcgplayer.market`
  ≥ **$10** AND `raw.near_mint.ebay.avg_7d` is present and within **~25%** of the TCGplayer market (a
  liquidity/agreement proxy). Reject null/sealed/one-sided cards.
- **Oracle price basis:** price a card off `raw.near_mint.tcgplayer.market` when liquid; **use the smoothed
  `ebay.avg_7d` below a liquidity threshold (~$25 NM market)** so a single relisting can't move a thin
  card's oracle. (Tunable.)
- **Variant:** **one market per canonical variant** — pick the highest-value/most-liquid variant of a
  physical card; do not spin up a separate market for every printing. One physical card ⇒ at most one index
  basket slot.
- **Dead-market retirement (P6 default):** a market with **zero open interest and zero volume for 30 days**
  is retired (removed from the refresh set). Markets with any OI are never retired.
- **Featured set size:** **top-250 by price per game** for the featured markets + index constituents
  (reuse `gradedConstituents`=100 sizing for the Graded basket).

These defaults are sensible starting points, not hard requirements — the operator can tune any of them.
