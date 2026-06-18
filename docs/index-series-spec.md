# Build spec — Multi-methodology index series (GJ / G&P / Pokedaq)

Three index *methodologies* over the same per-game baskets, each modelled on a real-world index family.
Replaces the single price-weighted index family with a branded three-series lineup. **Status: implemented**
on branch `feat/index-series` (`services/index-weighting.ts`, the `oracle.ts` buildIndex split, the
generated 22-market `INDEX_CATALOG`, and the sidebar series grouping).

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
Iₜ = Iₜ₋₁ · Σ_{i∈Cₜ} wᵢ · ( Pᵢ,ₜ / Pᵢ,ₜ₋₁ )
```
`cap(u, 0.05)` — the standard Nasdaq-style redistribution:
```
loop:
  over = { i : wᵢ > 0.05 }
  if over is empty: stop
  excess = Σ_{i∈over} (wᵢ − 0.05);  set each wᵢ∈over = 0.05
  under = { i : wᵢ < 0.05 };  underSum = Σ_{i∈under} wᵢ
  redistribute: for i∈under:  wᵢ += excess · (wᵢ / underSum)
```
Converges in a few passes; feasible for every basket (a 5% cap needs ≥20 names; the smallest basket,
Graded, has ≈78). First pass → `I = 1000`.

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
