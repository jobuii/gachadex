# Fees & Funding

**Three costs, all transparent: a trading fee, funding, and a liquidation penalty if you get liquidated.**
Each is a live, operator-set knob, and most of it flows to the liquidity pool that takes the other side of
your trade.

## Trading fee

A commission charged on **both** open and close, as a percentage of your position's **notional** (size ×
price) — the same rate for every market. If you hold an [affiliate fee discount](#referral), it's applied
here.

## Funding

Perpetuals use **funding** to keep the mark tethered to the index over time. When the book is skewed — say
most traders are long — funding flows **from the crowded side to the other**, scaled by how skewed it is. It
accrues continuously against your open position:

- On the **crowded** side → you pay funding (a holding cost).
- On the **other** side → you receive it (a credit).

It isn't a fee to the house — it's mostly a transfer between traders, and it's what makes a perpetual track
its underlying instead of drifting.

## Liquidation penalty

If a position is [liquidated](#trading), a penalty is taken from its remaining margin — it compensates the
pool for closing the position and discourages reckless leverage. You avoid it entirely by managing margin and
closing before you reach your liquidation price.

## Where the money goes

The LP pool is the counterparty to every trade, so it earns the bulk of these flows. Each stream has an
operator-configurable **LP / house split**:

| Stream | Default share to LPs | The rest |
|---|---|---|
| Trading fees | ~50% | house revenue |
| Funding | ~80% | house revenue |
| Liquidation penalties | ~60% | house revenue |

LPs also earn — or lose — the **net PnL of all traders**; see [Liquidity Pool](#lp). The Pool page surfaces
the LP's total fees earned and an APY from an operator-published snapshot.
