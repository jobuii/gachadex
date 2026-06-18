# Price-Index Data Lake & Universe Re-Derivation

**Status:** Phase 1 (data lake) + Phase 2 (analysis) complete · 2026-06-18
**Branch:** `feat/price-index` · **Plan parent:** [scrydex-pricing-build-spec.md](./scrydex-pricing-build-spec.md)

This document records the cross-provider price-index build and the analysis that drives
re-deriving the live trading universe. All figures captured 2026-06-18 against prod.

---

## 1. Why we did this

The live trading universe (~750 card markets, the "featured" top-250/game) was selected by the
**tcgpricelookup discovery job, ranked by the tcgpl _median_ price** — `median(eBay avg_1d, TCGplayer
market, eBay avg_7d)`. That median is the source of the live **eBay-median mispricing bug** (2 parts
garbage/identical eBay : 1 part correct TCGplayer → eBay outvotes the real price). So the universe
**inherited the bug**: median-inflated junk got ranked *in*, median-deflated gems got ranked *out*.

**Fix:** re-derive the universe from an _accurate_ price — the **raw TCGplayer market** (never the
median) — sourced from **both** Scrydex (premier, fresher) and tcgpricelookup, merged.

---

## 2. The price-index data lake

New table **`price_index`** (`apps/api/src/db/schema.sql`): one row per TCGplayer `product_id` (the
globally-unique cross-provider join key), holding the raw TCGplayer market price **and the full price
payload (JSONB)** from **both** feeds, for every card whose raw market is **≥ $10 in either feed**.

- Built by `apps/api/scripts/build-price-index.ts` (`importScrydexPrices` + `importTcgplPrices` in
  `apps/api/src/services/price-index.ts`).
- Scrydex: enumerate each game (prices included), upsert per variant-product. ~150k cards scanned.
- tcgpl: full catalog crawl (no price-sort), upsert. ~222k cards scanned.
- Idempotent (upsert by product_id), resumable (per-game offset checkpoint), full payloads stored so
  re-derivation never re-fetches.
- **NOT the live trading universe** — it's the analysis/derivation substrate and the on-demand
  listing-eligibility set.
- Ops note: the first run hung ~2h on a stalled socket; fixed with an `AbortController` request
  timeout in both provider clients + a resumable crawl (commit `a6faf95`).

---

## 3. Build results (2026-06-18)

Cards with raw TCGplayer market **≥ $10** in at least one feed:

| game     | rows (≥$10) | scrydex | tcgpl  | both   |
|----------|------------:|--------:|-------:|-------:|
| mtg      |      15,015 |   9,118 | 14,537 |  8,640 |
| pokemon  |       9,521 |   7,700 |  7,464 |  5,643 |
| onepiece |       1,455 |     754 |  1,398 |    697 |
| **TOTAL**|  **25,991** |**17,572**|**23,399**|**14,980**|

Scanned to produce this: Scrydex **150,551** cards · tcgpl **221,660** cards.
- tcgpl carries **more** ≥$10 products overall (23,399 vs 17,572) — especially MTG (14,537 vs 9,118)
  and One Piece (1,398 vs 754; Scrydex's OP catalog is only ~2,628 cards total).
- Scrydex-only ≥$10: ~2,592 · tcgpl-only ≥$10: ~8,419 · cross-validated (both): 14,980.

---

## 4. Analysis findings

### 4.1 The two feeds pick very different top-250s
Overlap of each feed's independently-ranked top-250 per game:

| game     | overlap of the two top-250s |
|----------|----------------------------:|
| mtg      | 205 / 250 = **82%**         |
| onepiece | 113 / 250 = **45%**         |
| pokemon  |  94 / 250 = **38%**         |

The universe is highly sensitive to which feed/price you rank by — Pokémon especially.

### 4.2 Merged top-250/game (Option B) — who prices each chosen card
Ranked by best-available raw TCGplayer market (Scrydex preferred, tcgpl fallback):

| game     | both | scrydex-only | tcgpl-only | price floor @250 |
|----------|-----:|-------------:|-----------:|-----------------:|
| mtg      |  195 |           34 |         21 |          $600.00 |
| onepiece |  118 |            4 |        **128** |      $274.74 |
| pokemon  |   93 |        **140** |         17 |        $561.60 |

**Neither feed alone is complete.** One Piece is **half tcgpl-only** (Scrydex would lose 128/250);
Pokémon is mostly **scrydex-only** (140/250). MTG is balanced. → Option B (merged) is required;
Option A (Scrydex-native) would gut One Piece.

### 4.3 The current universe is ~⅓ wrong
Re-deriving (merged) vs the current 749 featured markets:

| outcome        | count |
|----------------|------:|
| current featured | 749 |
| would **drop out** | **248** |
| would **enter**    | **249** |
| would **stay**     | 501 |

The median bug demonstrably polluted the set:

- **Current featured cards that are actually cheap (would drop):** City of Brass $31.89 · Birds of
  Paradise $18.82 · Final Fortune $17.41 · Kyogre ex (Nintendo Power) $30.25 · Misdirection $48.07 ·
  Vesuvan Doppelganger $50.00 · Pikachu #012/017 $57.15 · Bloodstained Mire $78.97.
- **Genuinely valuable cards missing (would enter):** リーリエ/Lillie $26,208 · Master's Scroll
  $8,112 · リーリエ $7,488 · Rayquaza VMAX $5,616 · リーリエ $4,680 · リザードンVMAX $4,492 ·
  Shining Tyranitar $4,249 · Celebi $3,999 · Cavern of Souls $3,975 · アセロラ/Acerola $3,744.
  (Many of the top entrants are **Japanese** — surfaced by Scrydex's JP coverage.)

### 4.4 Scrydex ↔ tcgpl disagreements
**570 of 14,980** cross-validated products (**3.8%**) disagree by **> 3×**. Sample:

| ratio | game     | Scrydex | tcgpl   | card |
|------:|----------|--------:|--------:|------|
| 11.9× | pokemon  | $335    | $3,999  | Shining Charizard |
|  8.0× | pokemon  | $4,000  | $500    | Celebi |
|  6.7× | pokemon  | $4,000  | $599    | Charizard Star (Delta Species) — *Scrydex fresher (tcgpl stale)* |
| 36.2× | mtg      | $31.89  | $1,155  | City of Brass |
| 32.2× | mtg      | $1,800  | $55.91  | Kozilek, the Broken Reality (Serial Numbered) |
| 12.8× | mtg      | $124.65 | $1,600  | Polluted Delta |
| 10.9× | mtg      | $109.94 | $1,203  | Flooded Strand |
|  7.4× | onepiece | $242.73 | $1,793  | Shanks OP09-004 (SP) |

Mix of Scrydex-fresher wins (the migration's whole point) and likely staleness / different-printing
mismatches. The per-game tiebreak (§5) decides which feed's value defines the universe.

---

## 5. Decisions (2026-06-18, confirmed by owner)

1. **Main top-250/game = English only.** JP printings excluded from the main 250.
2. **Disagreement tiebreak (which feed's price wins, for ranking + display):**
   - **Pokémon → Scrydex**
   - **MTG → Scrydex**
   - **One Piece → tcgpl** (Scrydex's OP coverage is thin; tcgpl is the more reliable OP feed)
3. **Separate tradeable set: JPY cards > $100.** Also listed/tradeable, surfaced via a JPY filter.
4. **GachaDex list filters (new UI):** Top Volume · Top Gainers · Top Losers · By Rarity · JPY ON/OFF.
   With JPY ON, the >$100 JP cards appear among the listing.

---

## 6. Forward plan

- **Phase 3 — derive + re-curate:** build the EN top-250/game (merged, per-game preferred feed) +
  the JPY>$100 set; re-curate `markets` **open-position-safe** (list new entrants, un-feature
  drop-outs; a market with a live position is never deleted — close-only, retire after 30d no-OI).
  The ~248-card churn must respect open positions.
- **UI — filters:** review the current market-list UI + how other exchanges present filterable lists;
  advise with options before building (Top Volume / Gainers / Losers / Rarity / JPY toggle).

## 7. Open items / to verify

- **Language (EN vs JP) signal:** Scrydex prices JP printings in JPY → the currency in the stored
  `scrydex_prices` payload is the EN/JP discriminator; tcgpl-only rows need a language signal too
  (set/name heuristics or a small re-enrichment). Needed to split the EN-250 from the JPY set.
- **JP valuation sanity-check:** extreme values (e.g. リーリエ $26,208 raw) may be thin-market or
  FX artifacts — verify before they anchor the JPY set.
- **The 570 >3× disagreements:** the per-game tiebreak resolves ranking, but spot-check the largest
  gaps (Kozilek, City of Brass, fetchlands) for stale/wrong feed data. The mark-guard clamp also
  protects at trade time.
