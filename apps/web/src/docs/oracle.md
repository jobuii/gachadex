# Pricing & Oracle

**A card's price is an opinion until you make it a number.** The oracle's job is to make that number honest —
so your entry, PnL, and liquidation reference a price you can trust, not a single cherry-picked sale.

## Where prices come from

The oracle **anchors to the TCGplayer market price** — sourced via **Scrydex**, a real pricing API, not a
homemade scraper — with an **eBay cross-check**. One Piece uses TCGplayer directly. The result is one
canonical price per card that feeds every market and every [index](#indices).

We deliberately reject the "eBay median" shortcut for graded cards — a live probe found it returns garbage on
thin markets (a PSA-10 chase card priced at a tenth of reality off one stale sale).

## Graded cards

Pokémon graded markets use a **Scrydex-first grade ladder** — a full **PSA / BGS / CGC** chain of low/high
prices and trends per grade — with TCGplayer as a fallback. The details panel shows the whole ladder; the
mark uses the relevant grade.

## From price to mark

That canonical price is the **index price**. The **mark** — the actual tradeable price — is the index price
adjusted by a small **premium** that reflects the order book's long/short **skew**. A heavily-long market
trades at a slight premium, a heavily-short one at a slight discount — and [funding](#fees) is what pulls the
mark back toward the index over time.

## Keeping it honest

- **Confidence + mark-guard.** A print that moves too far, too fast, or from a low-confidence source is
  **clamped** (the market briefly shows "price stabilizing") rather than instantly repricing your
  liquidations off a bad tick.
- **Webhooks + a polling backstop** keep marks current without hammering the source.
- **Indices are robust by construction** — aggregating many cards means no single bad print can whip them
  around, which is why indices are never price-gated the way a thin single card can be.
