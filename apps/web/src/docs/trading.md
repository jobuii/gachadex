# Trading

**Long if you think it goes up, short if you think it goes down — with leverage.** A position on GachaDex is
a perpetual: it has no expiry, it's priced off a live oracle mark, and you close it whenever you want.

## The mechanics

- **Side.** *Long* profits when the mark rises; *short* profits when it falls.
- **Leverage & margin.** Positions are **isolated-margin**: you post collateral (margin) and control a
  larger notional, up to the market's max leverage. Your margin is what's at risk — losses are capped at it.
- **The mark.** Every market has a synthetic **mark price** = the oracle index price adjusted by a small
  **premium** that reflects the book's long/short skew. Your entry, PnL, and liquidation all reference the
  mark, not a thin last-trade.
- **The counterparty.** There's no order book. The **liquidity pool** takes the other side of every trade,
  filling you at the current mark. That's why even large indices stay tradeable.

## Opening, managing, closing

1. **Open** — pick a market, choose long/short, set leverage and size. You're filled at the mark; an
   open fee applies (see [Fees & Funding](#fees)).
2. **Manage** — watch live unrealized PnL, your liquidation price, and accruing funding. Add or reduce as
   you like; partial closes are supported.
3. **Close** — realize PnL back to your collateral. A close fee applies.

## Liquidation

If the mark moves against you far enough that your margin can no longer cover the loss, the position is
**liquidated**: it's closed by the engine and a **liquidation penalty** is taken. Your liquidation price is
shown live on every open position — leverage moves it closer to the mark. Liquidations protect the pool;
keep a buffer. See [Risk](#risk).

## Funding

Perps use **funding** to tether the mark to the index over time. When the book is skewed (say, heavily
long), funding flows from the crowded side to the other, scaled by how skewed the book is. It accrues
continuously against your position — a cost if you're on the crowded side, a credit if you're against it.
Details in [Fees & Funding](#fees).

## Listing new markets (search-and-bet)

Don't see a card? **Search the catalogue** and list it on demand — a real, tradeable market is created from
the provider's data the first time it's requested (idempotent; an existing market is returned, not
duplicated). Bots and the CLI can do this too with a scoped key.
