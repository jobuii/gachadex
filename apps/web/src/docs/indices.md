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
| **Pokedaq** | Capped-weight | Nasdaq-100 | Price-weighted, but no single card exceeds **5%** (in baskets of 20+ cards) — the megacaps can't dominate. |

Why three? Because they tell different stories. A set can rip on its top chase card (GJ flies, G&P barely
moves) or grind up broadly (G&P leads). Trading the spread between methodologies is its own game.

## How each is computed

All three run over the **same baskets** and the **same canonical card price** (see [Pricing &
Oracle](#oracle)), so the only variable is the weighting. Every series is **chain-linked**: each oracle pass
multiplies the previous level by that pass's return, measured over the **previous** basket — then the basket
rebalances. Base value **1000**.

- **GJ — price-weighted (Dow-style).** Pass return = Σ(today's prices) ÷ Σ(previous prices) over the previous
  basket — the price-weighted move, exactly continuous across rebalances (the classic divisor adjustment).
- **G&P — equal-weight (S&P-EW-style).** Pass return = the **geometric mean** of each card's price change, so
  every card counts the same. (Geometric, not arithmetic: an arithmetic chain drifts upward when prices bounce —
  a card going $100 → $200 → $100 would wrongly leave it higher.)
- **Pokedaq — capped-weight (Nasdaq-100-style).** Pass return = the price-weighted **geometric** average change
  with each name **capped at 5%** (iteratively redistributed). Each card's weight is the average of its weight before
  and after the move (the Törnqvist method behind chained CPI), so a price that moves and comes straight back on the
  next update leaves the index where it was, and noisy back-and-forth doesn't build up drift. A basket with
  fewer than 20 priced cards can't meet a 5% cap, so for that pass every card counts equally.

Three rules keep every series honest:

- **Fresh prices only.** A card sits in a basket only while its price is live (refreshed within the last 36h —
  the same rule that halts a stale market). A frozen single-listing price can't move, so it never dampens an index.
- **Leavers count.** A card that leaves a basket — dropping out of the top-N (usually because its price fell),
  losing its featured slot, or going stale — still contributes its move on the way out, as long as it's priced
  that pass.
- **Outlier guard.** A card whose price moves 2× or more (up or down) in a single pass is left out of that
  pass's return — such jumps are almost always data errors (a mis-mapped printing, a placeholder listing). Its
  new price becomes its base, so a genuine re-price counts from the next pass on.

## How members change

An index with a published member list — it has a **Members** button on **Markets → Indices** and in the trade view —
keeps a **fixed list of cards** that changes once a month, the way the big stock indices are run:

- **Once a month.** Cards are ranked on their prices at **00:00 UTC on the 1st**. The change is announced that day
  and takes effect at the first price update **on or after the 4th**, never less than **3 days** after the
  announcement. The **Upcoming** tab shows what is coming in and going out.
- **A buffer at the cut-off.** In a Top 100, a card joins when it ranks **90th or better** and stays while it ranks
  **110th or better** (Top 250: **225** to join, **275** to stay). A card hovering around the line doesn't flip in and
  out every month. The basket holds exactly 100 (or 250) — fewer only if not enough cards qualify.
- **Who can join.** A featured single with a live, full-confidence price (not close-only), priced on GachaDex for at
  least **30 days**. The Graded index also needs a PSA 10 price.
- **Leaving between change dates — only for a reason.** The card is delisted, has had no fresh price for **14 days**
  (Graded: no PSA 10 for 14 days), or is removed by the operator with a stated reason. Its place goes to the best card
  on the **reserve list** (the runners-up of the last ranking), or else to the best card that may join right now — at
  the next price update, or as soon as one qualifies. A card that left this way comes back only when a later change
  takes effect, and a card already announced as coming in still waits for its date. A card whose price stops updating
  stays at its last price until it recovers or leaves.
- **If every card leaves** (say, a price outage): the index holds its level until prices return, then refills with the
  best cards that may join, as if starting fresh. While it has no cards, its price doesn't move, so trading switches
  to close-only after 36 hours and back on once it has cards again.
- **One printing per card.** When a card trades in several printings (say Normal and Foil), only its most valuable
  printing can be a member, checked on each change date.
- **No jump.** A change lands between two price updates, so the index level carries straight on — the move up to
  the change is measured on the old list, everything after on the new one.

Every change, with the reason each card left, is in the **Change log** tab.

## What's listed

Baskets are published per game — **Top 100** and **Top 250** for Pokémon, One Piece, and Magic — plus
**Pokémon Graded (PSA-10)**. Each appears in all three series (GJ / G&P / Pokedaq). Card baskets hold **single
cards only**: sealed product (booster boxes, displays, ETBs, bundles) is kept out of them. A **Sealed** basket
per game (in all three series) is defined but gated until a moving sealed-product price feed is wired — today's sealed prices
are static single listings.

An index is **listed but close-only** until its data flows, then auto-lights — no flag flip. Because indices
aggregate many cards, they're robust by construction and are **never price-gated** the way a thin single-card
market can be.

## Where to find them

The **Markets → Indices** tab is a financial-style overview: every index grouped by game, then by series,
showing the live price and **1D / 1W / 1M / YTD** change plus the **52-week low / high**. Click any row to
trade it. (YTD and 52W are measured over each index's available history — the series are young, so they read
"since launch" until a full year accrues.)
