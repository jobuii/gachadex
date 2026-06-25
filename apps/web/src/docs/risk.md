# Risk

**Read this one.** GachaDex is leveraged trading on volatile assets with thin underlyings. You can lose your
entire deposit — quickly. None of this is financial advice.

## Leverage & liquidation

Leverage multiplies both directions. Positions are **isolated-margin**: your margin is the most you can lose
on a position, but a move against you that exhausts it triggers **liquidation** — the engine closes the
position and takes a [penalty](#fees). Your liquidation price is shown live; higher leverage puts it closer
to the mark. Keep a buffer.

## Oracle & price risk

Marks come from an [oracle](#oracle). Card prices are noisier and thinner than equities — a real sale, a
provider hiccup, or a manipulation attempt can move a thin single-card market sharply. The mark-guard clamps
extreme or low-confidence moves and indices are robust by aggregation, but **single-card markets carry real
price risk.** Size accordingly.

## Liquidity-provider risk

LPs are the counterparty and bear **net trader PnL** — a run of winning traders draws the pool down. See
[Liquidity Pool](#lp).

## Smart-contract & custody risk

In real-funds mode, deposits are custodied with on-chain rails (per-user addresses, sweeps, proof-of-reserves,
auto-freeze). As with any crypto system, smart contracts and infrastructure can carry bugs. See [Custody &
Security](#custody).

## Experimental software

GachaDex is experimental: markets can be paused, prices can stabilize, and features ship behind flags. Only
trade what you can afford to lose, and prefer **play money** while you learn.

> Not financial advice. Not affiliated with Nintendo / The Pokémon Company, Bandai, or Wizards of the Coast.
> You are responsible for compliance with your own jurisdiction's rules.
