# The Indices

**Trade the whole set, not one card.** An index is a basket — instead of betting on a single Charizard, you
trade the price of an entire set or a curated top-N portfolio. One position, hundreds of cards of exposure.

What makes GachaDex's indices unusual: every basket is published in **three different methodologies** at
once, each modeled on a real-world stock index. Same cards, same canonical prices — three different ways to
weight them.

## The three series

| Series | Style | Modeled on | What it means |
|---|---|---|---|
| **GJ** | Price-weighted | Dow Jones | Higher-priced cards move the index more. |
| **G&P** | Equal-weight | S&P 500 (EW) | Every card counts the same — breadth, not whales. |
| **Pokedaq** | Capped-weight | Nasdaq-100 | Price-weighted, but no single card exceeds **5%** — the megacaps can't dominate. |

Why three? Because they tell different stories. A set can rip on its top chase card (GJ flies, G&P barely
moves) or grind up broadly (G&P leads). Trading the spread between methodologies is its own game.

## How each is computed

All three run over the **same baskets** and the **same canonical card price** (see [Pricing &
Oracle](#oracle)), so the only variable is the weighting:

- **GJ — price-weighted (Dow-style).** `value = Σ(constituent prices) × SCALE / divisor`. The divisor is
  chosen for a base of **1000** and **re-anchored** whenever the basket changes, so the print stays
  continuous across rebalances.
- **G&P — equal-weight (S&P-EW-style).** A chained average of each constituent's per-period return — every
  card contributes equally regardless of its price.
- **Pokedaq — capped-weight (Nasdaq-100-style).** Chained return with each name **capped at 5%**
  (iteratively redistributed), normalized so a flat pass is exactly flat (no drift).

## What's listed

Baskets are published per game — **Top 100** and **Top 250** for Pokémon, One Piece, and Magic — plus
**Pokémon Graded (PSA-10)**. Each appears in all three series (GJ / G&P / Pokedaq). **Sealed** indices are
defined but gated until a sealed-product price feed is wired.

An index is **listed but close-only** until its data flows, then auto-lights — no flag flip. Because indices
aggregate many cards, they're robust by construction and are **never price-gated** the way a thin single-card
market can be.

## Where to find them

The **Markets → Indices** tab is a financial-style overview: every index grouped by game, then by series,
showing the live price and **1D / 1W / 1M / YTD** change plus the **52-week low / high**. Click any row to
trade it. (YTD and 52W are measured over each index's available history — the series are young, so they read
"since launch" until a full year accrues.)
