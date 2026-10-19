# Build spec — Multi-methodology index series (GJ / G&P / Pokedaq)

Three index *methodologies* over the same per-game baskets, each modelled on a real-world index family.
Replaces the single price-weighted index family with a branded three-series lineup. **Status: implemented**
on branch `feat/index-series` (`services/index-weighting.ts`, the `oracle.ts` buildIndex split, the
generated 22-market `INDEX_CATALOG`, and the sidebar series grouping).

## 00. v3 membership rules (2026-10-18 plan; switch `INDEX_RULES_V3`, OFF by default)

v2 still re-sliced each basket every 6-hour pass from the featured cards, and the weekly discovery job could swap
most of the featured list (17 Oct 2026: 411 off, 530 on), with no record of which cards were members. v3 changes
only **who is a member**; the level math (v2 below) is unchanged. Code: `services/index-rules.ts` (pure rules),
`services/index-membership.ts` (DB: launch / publish / apply / causes), `index-baskets.ts` (`members` option),
tables `index_members`, `index_changes`, `index_exclusions`, view `index_locked_markets` (schema.sql).

| Rule | What |
|---|---|
| R1 | Monthly change date. Ranking uses each card's latest accepted price at 00:00 UTC on the 1st; published that day; effective at the first pass at or after max(the 4th 00:00 UTC, published + `INDEX_NOTICE_HOURS` 72h). One change per basket per month (unique), applied once. |
| R2 | Rank by raw price (Graded: raw price among cards with a PSA-10, valued at PSA-10). Pool = the game's featured singles + current members. |
| R3 | To join: featured, not delisted / reduce-only / low-confidence, fresh at the reference time, first live (non-backfill) price ≥ `INDEX_SEASONING_DAYS` (30) old; Graded also needs a PSA-10. |
| R4 | FTSE-style buffer: join at rank ≤ 90, stay while ≤ 110 (Top 250: 225 / 275; Graded scales with its size). Exactly N: too many → lowest-ranked go; too few → highest-ranked that may join fill in; fewer eligible → the basket holds fewer. |
| R5 | Between dates a member leaves only for a cause: delisted; no fresh price for `INDEX_STALE_REMOVE_DAYS` (14); Graded: no PSA-10 for 14 days; removed by hand. Reduce-only / low-confidence alone are not causes. |
| D3 | A leaver between dates is replaced by the best reserve (the change's runners-up, `RESERVE_SIZE` 20) that may join now, else (decision B, 2026-10-19) the best card that may join now. The basket keeps its size (`index_basket_size`: set at launch and to the size a change describes — `index_changes.size` — when it applies); a gap nothing can fill yet is filled on a later pass. Until a change applies, refills stop at the size it will leave, and never take or re-add a card it announces. |
| C | (2026-10-19) A basket that loses every member stays governed: empty, it holds its level (no print → the 36 h stale halt). It refills as a fresh start — the best that may join, up to N, the R11 bar lifted, size N until the next change applies. Switching the rules off ends it (`index_rules_off` marker). |
| R6 | A stale member stays at its last price (flat return), as v2 already does. |
| R7 | Discovery, the universe script and the hourly dead-market sweep never de-feature or delist a member, an announced addition or a reserve. Announced additions are re-checked at the effective pass and backed by reserves. |
| R8 | Continuity: the change lands between passes (this pass measured on the previous snapshot). |
| R9 | Public: `GET /markets/index-basket?symbol=…` — members, upcoming change, change log. |
| R10 | Launch: the first v3 pass takes the live basket (GJ series snapshot) as the member list — no jump; the first change date is the next 1st. |
| R11 | Removed by hand (`/admin/index-exclusions`): out of every basket until cleared. Removed for a cause: back only via a later change date, passing R3 — as a refill too: barred from the publish of the latest applied change (or launch / the latest fresh start) until the next one applies. Counted per era (since the latest launch). |
| R12 | One printing per product: only the most valuable printing of a TCGplayer product can be a member, fixed per change date. |

History: the rebuild reads `index_members` as of each pass from a basket's launch on, and before it the featured /
status flags as of each pass (`featured_events`, `market_status_events`, written by a trigger; seeded by
`scripts/seed-featured-events.ts`). Each pass also logs its basket, missing and outlier cards (`index_pass_log`).
Sealed keeps the v2 rule. Baskets stay keyed by card id: with printing markets (P5) each printing gets its own card id
(tcgpl ids are per printing) and `db/market-guards.ts` keeps live card ids unique per game (decided 2026-10-19 instead
of re-keying the stored snapshots and chain-link by market id). Public rules: the /docs Indices page, "How members
change".

## 0. v2 methodology (2026-10 audit) — SUPERSEDES the §2 math below

A live audit (2026-10-16) found the v1 series could not show a downturn: Pokémon Top-100 never fell more than
1% from a peak while a JP PSA-10 index fell 19% and our own day-one Pokémon basket fell 2.6%. Causes, each
measured on live data, and the fix for each (code: `apps/api/src/services/index-weighting.ts` `chainStep`,
`oracle.ts` `ingest`/`buildIndex`, `product-type.ts`):

| v1 defect | Evidence | v2 rule |
|---|---|---|
| G&P was a **Carli** index (chained arithmetic mean of relatives) — drifts up when prices bounce | same-basket replay: Pokémon Top-100 Carli +11.7% vs geometric −7.5%; MTG +95.9% vs −15.3% | G&P = **Jevons** (geometric mean) |
| GJ re-anchored the divisor to the **previous** level on any basket change → that pass's moves discarded | Pokémon Top-100: correct −1.5% → as-coded +6.5% | GJ = chained **Dutot** (Σ P₁ / Σ P₀ over the previous basket) — the correct divisor adjustment |
| Only cards present in **both** passes counted → a card that fell out of a top-N was never measured | survivorship ≈ 6–8 pts | the link is measured over the **previous basket**; leavers count |
| No guard on a single bad print | Entei ☆ $0.99 → $1,067 → G&P-250 ×6.1 in one pass; MTG G&P-250 reached 61,125 | **outlier guard**: a ≥ `INDEX_OUTLIER_FACTOR` (2×) single-pass move is left out of that pass |
| Frozen single-listing prices sat in baskets (halted for trading, still in the index) | 120 of 232 featured MTG cards had one print ever | **fresh-only**: an accepted print within `INDEX_FRESH_MS` (36h), market not halted/delisted |
| Sealed product counted as "cards" | 71% of Pokémon Top-100 by weight | card tiers = **singles** only; a per-game **Sealed** basket in all three series (9 markets; gated; building behind `SEALED_INDEX_ENABLED` — no sealed price has ever moved). The catalog is now 30 markets (the §3 "22" is v1) |

Cards with no usable price in a pass (missing or outlier) are imputed from the rest of the basket (left out of
Rₜ), never forced to a zero return. Discovery's featured set now requires a liquidity signal (eBay 7d sales or a
TCGplayer spread) and selects singles and sealed separately (`discovery.ts` `featuredSelection`). History is
recomputed under v2 by `apps/api/scripts/rebuild-index-history.ts` (reversible; see the script header).

## 1. Goal & scope

Today every index is price-weighted (`Index = Σ Pᵢ / divisor`) — methodologically a **Dow Jones**, which
concentrates the index into the few most expensive cards. We keep that as one series and add two more
weighting methodologies over the **same baskets and the same prices**:

| Series | Models | Method | Why |
|---|---|---|---|
| **GJ** (Gdex Jones) | Dow Jones | price-weighted (unchanged) | keep the existing index continuous |
| **G&P** | S&P 500 Equal Weight | equal-weight — each card contributes its % change equally | removes single-card domination; market breadth |
| **Pokedaq** | Nasdaq-100 | price-weighted, capped at 5%/card | keeps price-weighting but kills concentration |

**Price source (non-negotiable):** each constituent uses the **canonical per-card price — identical to
what the card market itself uses** (the same value `buildIndex` already reads as `rawE6`). That value is
`priceCard`/`combinePrice`. eBay is **never** a price input; post-Scrydex-cutover it's the TCGplayer-
anchored price. Fixing the per-card price (Scrydex cutover / dropping eBay from the median) fixes every
index automatically — there is no separate index price computation. See `docs/scrydex-pricing-build-spec.md`.

**In scope:** the catalogue expansion, the three weighting computations, the GJ rename-in-place migration,
UI labels, tests. **Out of scope (separate work):** the card-price correctness fix itself; a supply/
liquidity-weighted ("true market-cap") index (needs population/print-run data we don't have); a Sealed
data feed.

## 2. The three methodologies — exact math

Notation, per (game, tier) per pass `t`:
- `Bₜ` = the basket = the **top-N featured cards by price** for that game/tier (the existing selection;
  N = 100 / 250, or the graded set ≈ 78).
- `Pᵢ,ₜ` = card `i`'s canonical price this pass (§1).
- `Cₜ = Bₜ ∩ Bₜ₋₁` = constituents present **this pass and last pass** with a valid prior price (the
  chain-link set). Base index value = **1000** (`BASE_VALUE_E6 = 1_000_000_000`). All series recompute
  every oracle pass; all stay continuous across composition changes.

### GJ — price-weighted (UNCHANGED from today)
```
Iₜ = ( Σ_{i∈Bₜ} Pᵢ,ₜ ) / Dₜ
Dₜ  : anchored so I = 1000 at launch; re-pegged to Iₜ₋₁ whenever the constituent set changes
```
This is the current `buildIndex` divisor method (oracle.ts:295-369). **Left byte-for-byte unchanged** so
its value/divisor/history/open positions continue seamlessly — GJ *is* the existing index, renamed.

### G&P — equal-weight (chained equal-weighted return)
```
Iₜ = Iₜ₋₁ · (1/|Cₜ|) · Σ_{i∈Cₜ} ( Pᵢ,ₜ / Pᵢ,ₜ₋₁ )
```
Each card's return carries weight `1/N` of the index's return → no single card dominates. Continuity is
the chaining itself (a card entering/leaving contributes no return the pass it changes — exactly the role
GJ's divisor re-peg plays). First pass (no prior level/snapshot) → `I = 1000`. `|Cₜ| = 0` (impossible in
practice) → carry forward (`R = 1`).

### Pokedaq — capped price-weight, 5%/card (chained capped-weight return)
```
raw weights:   uᵢ = Pᵢ,ₜ₋₁ / Σ_{j∈Cₜ} Pⱼ,ₜ₋₁
capped:        wᵢ = cap(u, 5%)        # iterative, below
w̄ᵢ = ( cap(u at Pₜ₋₁)ᵢ + cap(u at Pₜ)ᵢ ) / 2   # Törnqvist (2026-10-17)
Iₜ = Iₜ₋₁ · Π_{i∈Cₜ} ( Pᵢ,ₜ / Pᵢ,ₜ₋₁ ) ^ ( w̄ᵢ / Σ w̄ )
```
Not Σ wᵢ·(Pᵢ,ₜ/Pᵢ,ₜ₋₁) with Pₜ₋₁ weights: that arithmetic chain drifts UP wherever the cap binds (Carli), and the
geometric mean with Pₜ₋₁ weights drifts DOWN wherever it doesn't. Averaging the start and end weights makes a move
undone on the next pass cancel exactly (time reversal), capped or not — the chained-CPI method. Longer cycles aren't
exactly circular (review sim: ≤0.3% over a 5-pass ±15% cycle) but carry no systematic drift (mean ≈0 over 600 passes).
`cap(u, 0.05)` — the standard Nasdaq-style redistribution:
```
loop:
  over = { i : wᵢ > 0.05 }
  if over is empty: stop
  excess = Σ_{i∈over} (wᵢ − 0.05);  set each wᵢ∈over = 0.05
  under = { i : wᵢ < 0.05 };  underSum = Σ_{i∈under} wᵢ
  redistribute: for i∈under:  wᵢ += excess · (wᵢ / underSum)
```
Converges in a few passes. A 5% cap needs ≥20 names: a pass with fewer priced names (MTG's early
history had 2–10 fresh cards) can't meet it, so every name gets the cap — equal weight (2026-10-17 fix; the
loop above used to end with the cheapest names holding the excess). First pass → `I = 1000`.

**Worked sanity check (Pokémon Top 100, live numbers):** GJ divisor = 100.2638, Σ Pᵢ ≈ \$100,018, GJ ≈
997.55. Under Pokedaq, any card worth > 5% of \$100,018 (≈ \$5,000) is capped to 5% and its excess spread
across the rest; under G&P every one of the 100 cards drives exactly 1% of the daily move.

## 3. Index catalogue (22 markets)

Each series shares the same baskets; only the weighting differs. **Graded & Sealed are Pokémon-only**
(that's where the data is). `topN`: 100 / 250 / null(graded uses the PSA-10 set).

| Series | Game | Tier | slug | symbol | display name | tradeable |
|---|---|---|---|---|---|---|
| GJ | pokemon | top-100 | `top-100` | `INDEX:top-100` | **GJ Top 100** | yes |
| GJ | pokemon | top-250 | `top-250` | `INDEX:top-250` | **GJ Top 250** | yes |
| GJ | pokemon | graded | `graded` | `INDEX:graded` | **GJ Graded (PSA 10)** | yes |
| GJ | pokemon | sealed | `sealed` | `INDEX:sealed` | **GJ Sealed (soon)** | no (gated) |
| GJ | onepiece | top-100 | `top-100` | `INDEX:onepiece:top-100` | **GJ Top 100** | yes |
| GJ | onepiece | top-250 | `top-250` | `INDEX:onepiece:top-250` | **GJ Top 250** | yes |
| GJ | mtg | top-100 | `top-100` | `INDEX:mtg:top-100` | **GJ Top 100** | yes |
| GJ | mtg | top-250 | `top-250` | `INDEX:mtg:top-250` | **GJ Top 250** | yes |
| G&P | pokemon | top-100 | `gp-top-100` | `INDEX:gp-top-100` | **G&P Top 100** | yes |
| G&P | pokemon | top-250 | `gp-top-250` | `INDEX:gp-top-250` | **G&P Top 250** | yes |
| G&P | pokemon | graded | `gp-graded` | `INDEX:gp-graded` | **G&P Graded (PSA 10)** | yes |
| G&P | onepiece | top-100 | `gp-top-100` | `INDEX:onepiece:gp-top-100` | **G&P Top 100** | yes |
| G&P | onepiece | top-250 | `gp-top-250` | `INDEX:onepiece:gp-top-250` | **G&P Top 250** | yes |
| G&P | mtg | top-100 | `gp-top-100` | `INDEX:mtg:gp-top-100` | **G&P Top 100** | yes |
| G&P | mtg | top-250 | `gp-top-250` | `INDEX:mtg:gp-top-250` | **G&P Top 250** | yes |
| Pokedaq | pokemon | top-100 | `pdq-top-100` | `INDEX:pdq-top-100` | **Pokedaq 100** | yes |
| Pokedaq | pokemon | top-250 | `pdq-top-250` | `INDEX:pdq-top-250` | **Pokedaq 250** | yes |
| Pokedaq | pokemon | graded | `pdq-graded` | `INDEX:pdq-graded` | **Pokedaq Graded (PSA 10)** | yes |
| Pokedaq | onepiece | top-100 | `pdq-top-100` | `INDEX:onepiece:pdq-top-100` | **Pokedaq 100** | yes |
| Pokedaq | onepiece | top-250 | `pdq-top-250` | `INDEX:onepiece:pdq-top-250` | **Pokedaq 250** | yes |
| Pokedaq | mtg | top-100 | `pdq-top-100` | `INDEX:mtg:pdq-top-100` | **Pokedaq 100** | yes |
| Pokedaq | mtg | top-250 | `pdq-top-250` | `INDEX:mtg:pdq-top-250` | **Pokedaq 250** | yes |

GJ keeps the **bare** tier slugs (`top-100`…) so its symbols are unchanged and history/positions survive
(§6). The "Pokedaq"/"G&P" brand names appear under the One Piece / MTG game switcher too (per decision).

## 4. Data model & schema

- **`packages/shared-types`** — `INDEX_CATALOG` gains a `series` (`'gj'|'gp'|'pdq'`) and a `weighting`
  (`'price'|'equal'|'capped'`, + `capBps` for Pokedaq) per entry, and the catalogue is expanded to the 22
  rows above. `INDEX_SLUGS` is extended with the `gp-*`/`pdq-*` slugs (additive; it backs the
  `MarketSchema.indexSlug` enum). `name` becomes the display label (e.g. `GJ Top 100`).
- **DB** — no new tables. Index markets are still created by `upsertIndexMarket` (markets.ts:104), keyed
  by symbol; the new slugs produce the new symbols above. `index_constituents` / `index_divisors` are
  already keyed per `market_id`, so they work per series untouched. **GJ** keeps using `index_divisors`;
  **G&P / Pokedaq are chained-return and need no divisor** — they read their own previous level (last
  `oracle_prices` row) and previous prices (their own previous `index_constituents` snapshot), both of
  which `buildIndex` already persists per market.

## 5. Computation (oracle.ts)

`ingest` already builds `featuredByGame` (sorted, price-descending) and a graded set per game. Change the
index loop so that, per (game, tier), the **basket is selected once** and then **each active series emits
its own level**:

1. Select `members` = top-N featured (or the graded set) — unchanged selection logic.
2. For each series in {GJ, G&P, Pokedaq} present for that (game, tier):
   - Resolve/`upsertIndexMarket` for that series' slug → `marketId`.
   - Read the **previous** snapshot (card_id → price) and previous level for `marketId` *before*
     overwriting them.
   - Compute the level via the weighting:
     - `price` → existing divisor method (GJ — call the unchanged code path).
     - `equal` / `capped` → the chained-return formulas (§2) via a new pure module
       `services/index-weighting.ts` (`equalWeightLevel(prevLevel, prev, cur)`,
       `cappedWeightLevel(prevLevel, prev, cur, capBps)`).
   - Snapshot constituents, `recordOracle`, `recomputeMark` — exactly as today.

GJ's branch is the current `buildIndex` verbatim. The new module is pure (no DB) and unit-tested in
isolation. Graded is tripled the same way (same PSA-10 member set, three weightings).

## 6. Migration — rename existing → GJ, in place

The 8 existing index markets become the GJ series **without changing their symbols** — only
`display_name` changes (e.g. `Top 100` → `GJ Top 100`). Because `upsertIndexMarket` does
`ON CONFLICT(symbol) DO UPDATE SET display_name…`, simply changing the catalogue `name` renames them on
the next ingest pass. Market id, oracle/mark history, divisor, and any open positions all carry over —
GJ's math is identical to today's, so values continue seamlessly (no reset).

G&P and Pokedaq markets are **created fresh** on the first ingest pass after deploy, launching at **1000**
and coming alive as the card feed updates.

## 7. UI (apps/web)

- The markets/index view groups indices by **series** (GJ / G&P / Pokedaq) using the new `series` field,
  with the display names from §3. The existing **game switcher** filters by game as it does now.
- No new endpoints — the indices are ordinary markets; the web reads `series`/`displayName` off the
  markets list. (Optional polish: a short tooltip per series — "price-weighted / equal-weight / capped 5%".)

## 8. Tests

- `index-weighting.test.ts` (pure): equal-weight return over a 3-card basket; capped redistribution
  converges and respects 5% with a dominant card; common-name continuity (a card entering or leaving
  causes **no** level jump); degenerate `|C|=0` carries forward.
- Regression: GJ level/divisor output is unchanged for a fixed basket (guards the rename-only promise).
- Worked before/after: take a current Pokémon Top 100 basket snapshot and assert GJ vs G&P vs Pokedaq
  produce the expected divergence (GJ dominated by the top cards; G&P even; Pokedaq capped).

## 9. Rollout & reversibility

- Additive and independent of the card-feed fix. The GJ rename is behaviour-preserving; G&P/Pokedaq launch
  at 1000 and are dormant-flat until the feed moves (same as GJ today).
- **Sequence:** (1) restore the card price feed; (2) ideally complete the Scrydex cutover so `Pᵢ` is the
  clean TCGplayer-anchored price; (3) ship this index-series change. Steps are independent but the indices
  only *mean* anything once (1)/(2) are done.
- Reversible: delist the G&P/Pokedaq markets; revert the GJ `name` change (symbols never moved).

## 10. Decisions

1. ✅ **Scope: all three games.** GJ/G&P/Pokedaq Top 100 + Top 250 for Pokémon, One Piece, MTG. Graded &
   Sealed remain Pokémon-only. (22 markets.)
2. ✅ **Cap = 5%/card** for Pokedaq.
3. ✅ **Base = 1000**, recomputed every oracle pass, continuous across composition changes.
4. ✅ **Price = the canonical per-card price** (same as the card market); eBay never a price input.
5. ✅ **GJ unchanged** (divisor method) and **renamed in place** (symbols preserved → history/positions
   survive). G&P/Pokedaq are new chained-return markets.
