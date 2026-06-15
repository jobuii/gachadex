# Price discovery — current approach (as of 2026-06-15)

How a card's tradeable price is produced today, end to end: from raw provider signals → a fair-value
USD number → an accepted oracle print → the synthetic **mark** that positions trade and liquidate
against. This documents the **current** mechanism only (no proposed changes).

Provider feed selected by `ORACLE_PRIMARY` (live = `tcgpricelookup`); base
`https://api.tcgpricelookup.com/v1`. Oracle re-pulls every `ORACLE_REFRESH_MS` (default **6h**;
source updates ~daily).

---

## Data flow

```
provider signals ─▶ priceCard() ─▶ recordOracle() ─▶ applyConfidence() ─▶ recomputeMark() ─▶ mark
(tcgplayer mkt,     (one fair-value  (accept/reject    (low_confidence      (index × (1+premium))   │
 eBay 1d/7d/30d)     USD number)      the print)        ⇒ reduce-only)                               ▼
                                                                                          chart + 24h change
```

- **index price** = `priceCard` output (cards) or basket NAV (indices). The oracle's fair value.
- **mark** = the index nudged by open-interest skew; **the number the UI shows and the engine
  liquidates against.** With zero open interest, mark = index.
- chart + 24h change are computed off the **marks** series.

---

## 0. Source signals (`providers/tcgpricelookup.ts:fetchTrackedCards`)

Per tracked card, per condition, the provider returns four numbers:

- **TCGplayer market price** — `spot`
- **eBay average — 1-day / 7-day / 30-day** — `a1` / `a7` / `a30`

`observedAt` for the print = `last_price_update ?? updated_at` (the price-freshness timestamp).

## 1. `priceCard()` — raw signals → one fair-value USD number (`providers/tcgpricelookup.ts`)

Five steps, in order:

1. **Condition fallback** — `CONDITION_ORDER = [near_mint, lightly_played]`. Use near-mint; if it has
   no usable data, fall back to lightly-played; if neither, the card is **unpriced ($0)** and the
   oracle skips it.
2. **Anchor = `median(TCGplayer, eBay-7d, eBay-30d)`** — the trusted fair value (the eBay **1-day** is
   deliberately excluded). The median makes it outlier-resistant; because 7d/30d are slow averages,
   the anchor **lags** fast moves.
3. **Agreement gate** — `agree = (≥2 anchor signals) AND (max ≤ 3× min)` (`AGREEMENT_MAX_RATIO = 3`).
   If it fails, return the **bare anchor** and mark the card **low-confidence** (→ reduce-only).
4. **Live signal = eBay-1d** (or the anchor if there is no 1-day) — the input meant to move daily.
5. **±25% clamp** — `price = clamp(eBay-1d, anchor×0.75, anchor×1.25)` (`PRICE_BAND = 0.25`). The live
   price can never sit more than ±25% from the anchor. This is the main anti-manipulation **and**
   single-print gap limiter — and, because the anchor lags, also the main dampener of real moves.

Output: a USD price (rounded to $0.01) + a `confident` flag. `usd = 0` ⇒ unpriced.

## 2. `recordOracle()` — accept or reject the print (`oracle.ts`)

- **60% outlier reject** — reject a candidate **>60% from the last accepted price**
  (`OUTLIER_THRESHOLD = 0.6`). Rarely fires, because step 1.5 already capped the move to ±25%.
- **Persistence hatch** — a rejected >60% move is **force-accepted once the previous print already
  showed that level**, so a genuine large move can't be rejected forever.
- **Dedup** — `ON CONFLICT(market_id, source_observed_at) DO NOTHING`: one print per provider
  snapshot timestamp (`source_observed_at = last_price_update`).

## 3. `applyConfidence()` — restriction (`oracle.ts`)

`confident = false` ⇒ `markets.low_confidence = true` ⇒ the engine **blocks new positions
(reduce-only)**; a `market_restriction_events` row is logged on each flip. The price still displays.

## 4. `recomputeMark()` → `syntheticMark()` — index becomes the tradeable mark (`marks.ts`)

```
mark = clamp(index × (1 + premium), ±max_dev_bps),   premium = clamp(k × skew/depth, ±premium_cap)
```

`skew` = signed long−short open interest. Longs heavy ⇒ premium > 0 ⇒ mark > index. With no open
interest, **mark = index**. `depth` falls back to `config.depthFloorUusdc` when 0. The engine
recomputes this on every trade, so order flow moves the mark intraday.

## 5. Chart + 24h change (`markets.ts`)

Both off the **marks** series. 24h change = latest mark vs the last mark recorded **≤ 24h ago**;
**defaults to 0%** when there is no qualifying reference (or when the latest mark equals it).

## 6. Manual operator override / pin (`admin-pricing.ts`)

An operator sets a price by hand → it writes an accepted print + recomputes the mark and **pins** the
market (`price_pinned`). The auto-oracle **skips pinned markets** until unpinned. The human fallback
for a wrong/stale feed.

---

## Side channels

- **Index markets** (`oracle.ts:buildIndex`): per-game, featured-only baskets.
  `value = Σ(constituent prices) × SCALE / divisor`; the divisor is anchored so the index starts at
  1000 (`BASE_VALUE_E6 = 1e9`) and is re-based on a constituent-set change (continuity), with a
  wrong-scale self-heal (`REANCHOR_JUMP_FACTOR = 4`).
- **Graded (PSA-10)**: `gradedPsa10Usd` = eBay `avg_7d ?? avg_1d ?? avg_30d` of `graded.psa['10']`,
  supplied inline by the provider; **JustTCG fallback** (`oracle.ts:fetchGradedPrice`, requires
  `JUSTTCG_API_KEY`) when the raw provider has none. Feeds the Graded index + the per-card graded
  panel — **not** the raw mark.
- **Market-creation gate** (P6 search-and-bet, `tcgpricelookup.ts:isListable`): a card is only
  listable if NM TCGplayer market ≥ `$10` (`MIN_LIST_PRICE_USD`) and the eBay 7d agrees within ~25%
  (`PRICE_AGREEMENT_TOLERANCE`). Distinct from ongoing pricing.

---

## Constants

| Constant | Value | Where | Role |
|---|---|---|---|
| `CONDITION_ORDER` | near_mint → lightly_played | priceCard | grade fallback |
| `AGREEMENT_MAX_RATIO` | 3× | priceCard | confidence gate |
| `PRICE_BAND` | 0.25 (±25%) | priceCard | clamp live to anchor |
| `OUTLIER_THRESHOLD` | 0.60 (60%) | recordOracle | reject wild jumps |
| `ORACLE_REFRESH_MS` | 6h | config | re-pull cadence |
| `BASE_VALUE_E6` | 1000.0 | buildIndex | index base value |
| graded chain | eBay 7d→1d→30d | gradedPsa10Usd | PSA-10 price |

## The four price-control mechanisms

| Mechanism | Lives in | Protects against | Cost / side effect |
|---|---|---|---|
| Anchor = median(TCGP, 7d, 30d) | priceCard | a single bad/manipulated source | lags real moves (2 of 3 are slow averages) |
| ±25% clamp | priceCard | manipulation **and** single-print gap | **dampens legitimate fast moves** |
| Agreement gate (3×) | priceCard | trading a price we can't cross-check | thin/illiquid cards go reduce-only |
| 60% reject + persistence | recordOracle | a wild single-print jump | rarely fires (clamp pre-empts); 1-cycle delay on big moves |

Gap risk is **also** handled independently by the engine (liquidations, ADL, insurance fund, OI
caps) — so the ±25% clamp is a redundant, second gap limiter layered on top.

---

## Worked example (one card, calm day, some open interest)

TCGplayer $10.50, eBay 1d $10.00 / 7d $10.20 / 30d $9.80:

1. Anchor = median(10.50, 10.20, 9.80) = **$10.20**
2. Agreement: 10.50 / 9.80 = 1.07× ≤ 3 ⇒ **confident** (tradeable)
3. Live = eBay-1d = $10.00
4. Clamp to [$7.65, $12.75] ⇒ $10 is inside ⇒ **index = $10.00**
5. Oracle: <60% from prior ⇒ accepted
6. Mark: longs slightly heavy, premium +1% ⇒ **mark = $10.10** (the displayed/traded price)
7. Chart records $10.10; 24h change measured vs yesterday's mark.

---

## Known limitations (observed 2026-06-15)

- **Real moves are dampened.** Because the anchor is a median that includes the slow 7d/30d
  averages, and the live price is clamped to ±25% of it, a genuine fast move can't be reflected until
  the slow averages catch up (days). The clamp does double duty (manipulation guard + gap limiter),
  which is why it over-suppresses.
- **Flat feed ⇒ 0% / 24h across the board.** Live DB check (2026-06-15): the provider advances
  `last_price_update` every pull but the underlying values were unchanged for days (e.g. a card's
  eBay 1d/7d/30d byte-identical across 4 days; the live API returned the same numbers). Ingestion is
  correct — the upstream values simply aren't moving — so marks are flat and 24h change reads 0%.
- **Only one independent cross-check.** Of the inputs, eBay 1d/7d/30d are all eBay-derived; only
  TCGplayer market is an independent venue. A sustained single-venue (eBay) move/manipulation is only
  weakly cross-checked.

## File reference

- `apps/api/src/services/providers/tcgpricelookup.ts` — `priceCard`, anchor/agreement/clamp, graded,
  `fetchTrackedCards`, `fromTplCard`, `isListable`
- `apps/api/src/services/oracle.ts` — `recordOracle` (accept/reject + persistence + dedup), `ingest`,
  `ingestCard`, `applyConfidence`, `buildIndex`, `primaryFetcher`
- `apps/api/src/services/marks.ts` — `recomputeMark` → `@pokex/pricing.syntheticMark`
- `apps/api/src/services/markets.ts` — markets list + 24h change off the marks series
- `apps/api/src/services/admin-pricing.ts` — manual price override + pin

---

# New approach — median of three (decided 2026-06-15; to implement)

**Status:** chosen direction; implementation pending. Replaces the current ±25%-clamp approach above.
Risk gates (per-card max-leverage, ADL, insurance fund, OI caps) are assumed **ON in production**, so
gap risk is handled by the **engine** — the price feed's only job is to report the true price.

**One sentence:** instead of "take the live eBay price and clamp it to a slow average," take the
**middle of three price sources** — the middle automatically ignores any single source that's lying,
and moves the instant two sources agree.

## The flow, step by step

0. **Read three prices** (per card, per condition): eBay 1-day avg, TCGplayer market, eBay 7-day avg.
   (30-day is still fetched but no longer feeds the price.)
1. **Pick the grade** — near-mint, else lightly-played, else unpriced. *(kept, unchanged)*
2. **Price = the middle (median) of the three.** A spike or a wrong source is the highest or lowest,
   so the middle skips it; the price moves only when **≥2 sources agree**. The median *is* the
   manipulation filter — no clamp, no agreement gate.
3. **Confidence flag (spread check):** if the three are wildly far apart (highest > ~2× the lowest, or
   fewer than two usable sources), flag the card **low-confidence**. This does **not** change the
   price; it only raises a flag.
4. **Reduce-only when flagged:** a low-confidence flag puts the market in **reduce-only** (close
   positions yes, open new ones no), so nobody bets against a price we can't cross-check. Clears
   automatically once the sources agree again. *(existing plumbing; trigger is now the spread flag)*
5. **Record only when the value changes (dedup on value):** if the new median equals the last recorded
   price, do nothing; write a new point only on a real change. *(changed)*
6. **Mark:** the median is fair value; the tradeable **mark** = fair value nudged by long/short skew.
   No open interest ⇒ mark = fair value. *(kept, unchanged)*
7. **Chart + 24h, manual pin** — *(kept, unchanged)*

## Kept / changed / dropped vs the current flow

| Stage (current) | Decision | Notes |
|---|---|---|
| 0. Fetch signals (TCGP, eBay 1d/7d/30d) | ✅ KEEP | price uses **1d, TCGP, 7d**; 30d no longer feeds the price. |
| 1a. Condition fallback NM→LP | ✅ KEEP | unchanged. |
| 1b. Anchor = median(TCGP, 7d, 30d) | 🔄 CHANGE | → `price = median(eBay-1d, TCGP, eBay-7d)`, used **directly** as the price. |
| 1c. Agreement gate (3×) | ❌ DROP | replaced by the median + the light **spread flag** below. |
| 1d. Live = eBay-1d | ✅ KEEP | now one of the three median inputs. |
| 1e. ±25% clamp | ❌ DROP | the dampener. |
| 2a. 60% outlier reject | ❌ DROP | gap risk → the engine (gates on in prod). |
| 2b. Persistence hatch | ❌ DROP | (was only there to pair with the guard). |
| 2c. Dedup (on `source_observed_at`) | 🔄 CHANGE | **dedup on the computed value** — see below. |
| 3. Reduce-only mechanism | ✅ KEEP, 🔄 rewire trigger | same `low_confidence → reduce-only` plumbing, now fired by the **spread flag** instead of the agreement gate. |
| 4. Mark = index × (1+premium) (skew) | ✅ KEEP | unchanged. |
| 5. 24h change + chart | ✅ KEEP | unchanged. |
| 6. Manual override / pin | ✅ KEEP | unchanged. |
| Index baskets / Graded + JustTCG | ✅ KEEP | unchanged; indices sum constituent prices, now from the median. |
| Engine risk (liquidation, ADL, insurance, OI caps, max-leverage) | ✅ KEEP | the **sole** gap-risk handler now. |

**Net:** drop 4 mechanisms (±25% clamp, 3× agreement gate, 60% reject, persistence). The price layer
becomes **median (price + manipulation filter) + spread flag (confidence) + value-dedup.**

## The two controls we keep at the price layer (plain English)

- **Spread flag** — after taking the median, look at how far apart the three sources are. If the
  highest is more than ~2× the lowest (or there are fewer than two usable sources), the data is too
  shaky to trust → mark the card **low-confidence**. It never moves the price; it only raises a flag.
- **Reduce-only** — a low-confidence flag flips the market to **reduce-only**: traders can *close* but
  not *open*. Same plumbing as today; only the trigger changes (old: 3× agreement gate → new: spread
  flag). It clears on its own once the sources agree again.

## Dedup — on value (decided 2026-06-15)

Today dedup keys the no-op insert on `(market_id, source_observed_at)`, where `source_observed_at` is
the provider's `last_price_update`. But tcgpricelookup **advances `last_price_update` on every pull
even when the value is unchanged**, so the key keeps changing → a fresh identical-value print + mark
is written every cycle, and dedup never fires.

**Change:** key the no-op on the **computed price value** — skip writing a new print + mark when the
new median equals the last accepted price. A new mark lands only on a real change. (24h change is
unaffected: it references the last mark ≤24h ago, so a genuinely static card correctly reads 0%.)

## Gap risk — the engine, not the price

A big move now prints in full immediately. The trader's loss is capped at their margin (isolated
margin); the engine's controls (conservative max leverage, insurance fund, ADL, OI caps — all **ON in
production**) absorb the tail. The price layer no longer does gap-limiting.

## Residual to be aware of

With no reject, a simultaneous **two-source** glitch (both eBay and TCGplayer wrong at once) prints
for one cycle and self-corrects on the next pull. A single-source glitch is still ignored by the median.

## Worked example (one card)

Provider gives eBay-1d **$10.00**, TCGplayer **$10.50**, eBay-7d **$10.20**:
1. Grade: near-mint has data → use it.
2. Median of (10.00, 10.50, 10.20) = **$10.20** ← the price. *(today's clamp logic would show $10.00.)*
3. Spread: 10.50 / 10.00 = 1.05× → narrow → **confident, tradeable.**
4. Changed vs last recorded ($10.10)? yes → record the new point.
5. Mark: slight long skew, +1% premium → **mark $10.30** (displayed/traded price).

The cases that matter:
- **Real +110%** — eBay-1d $33, TCGP $33.5, 7d $17.7 → median **$33**, tracks instantly.
- **Manipulation** — eBay-1d $30 (fake), TCGP $16, 7d $13.6 → median **$16**, fake spike ignored.
- **Calm** — all three ~$10 → ~$10, unchanged (no new point written).

## Implementation plan

### Backend
1. **`priceCard` (`providers/tcgpricelookup.ts`)** — replace the anchor/agreement/clamp body with, per
   the condition fallback: `sigs = [eBay-1d, TCGplayer-market, eBay-7d]` filtered to `> 0`;
   if `sigs` empty, try the next condition; `usd = median(sigs)`;
   `confident = sigs.length >= 2 && max(sigs) <= SPREAD_MAX_RATIO × min(sigs)`. Return `{ usd, confident }`.
   - Delete `PRICE_BAND` and `AGREEMENT_MAX_RATIO`; add `SPREAD_MAX_RATIO` (≈ **2**, tunable). Keep the
     `median` + `cents` helpers and the `usd = 0 ⇒ unpriced` behavior.
2. **`recordOracle` (`oracle.ts`)** — delete the 60% `OUTLIER_THRESHOLD` reject + persistence block.
   **Value-dedup:** if the new value equals the last accepted value, no-op (no print, no mark); else
   insert + accept. Keep the `source_observed_at` column for audit (the unique index can stay as a
   belt-and-suspenders).
3. **`applyConfidence` / reduce-only** — plumbing unchanged; `confident` now comes from the spread
   check, so reduce-only is driven by the spread flag automatically.
4. **Untouched:** `recomputeMark`/`syntheticMark`, `markets.ts` 24h/chart, `admin-pricing` pin,
   `buildIndex`, graded + JustTCG, all engine risk controls.

### Tests
- `providers/tcgpricelookup.test.ts` — median price (real move tracks; single spike outvoted), spread
  flag → `confident=false`, condition fallback, single-signal (price = that source, low-confidence).
- `oracle.test.ts` — value-dedup (unchanged value ⇒ no new print/mark; changed ⇒ new mark); remove the
  60%/persistence tests.
- `markets.test.ts` — 24h change is non-zero after a real move.

### Out of scope (separate decisions)
- `isListable` market-creation gate (NM ≥ $10 + eBay-7d within 25%) — unchanged.
- Risk-engine sizing (leverage / insurance / ADL / OI) — assumed configured in prod.

### Rollout
Code-only change to two functions, behind the existing `ORACLE_PRIMARY=tcgpricelookup` path. **No
schema change** (value-dedup reuses existing columns). Reversible by reverting the two functions.
