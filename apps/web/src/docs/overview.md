# Overview

**Trade trading cards like an asset class.** GachaDex is a leveraged, real-USDC venue for trading-card
prices — go long or short on individual cards, on graded slabs, or on whole-set **indices**, with leverage,
across **three games: Pokémon, One Piece, and Magic: The Gathering**.

Most people who love cards can only do one thing with a price chart: watch it. GachaDex turns that chart
into something you can actually trade — up or down, with size — without ever shipping a card, grading a
slab, or waiting on a sale.

## Why it's different

- **Three games, one venue.** Pokémon, One Piece, and Magic markets sit side by side — not a single-game silo.
- **Real index methodologies.** Every basket is published in three weightings modeled on the world's stock
  indices: **GJ** (price-weighted, Dow-style), **G&P** (equal-weight, S&P-style), and **Pokedaq**
  (capped-weight, Nasdaq-style). You trade the *methodology*, not just the basket. See [The Indices](#indices).
- **Honest pricing.** Prices anchor to **Scrydex** market data, with a **TCGplayer / eBay cross-check** and
  a full **PSA / BGS / CGC graded ladder** — not one scraped number. See [Pricing & Oracle](#oracle).
- **A place, not just a tool.** Live chat, a leaderboard, the **DROP** giveaway pot, and a referral /
  affiliate program sit alongside the exchange.

## How it works, in one breath

Connect a Solana wallet, fund your account (a play-money faucet, or a real-USDC deposit), and open
**perpetual positions** priced off a live oracle **mark**. The **liquidity pool** is the counterparty to
every trade — fees, funding, and trader PnL flow to LPs. Settlement runs on a **double-entry ledger** (every
balance reconciles to the cent), and **custody of real USDC is on-chain** (per-user deposit addresses,
sweeps, and proof-of-reserves).

| | |
|---|---|
| **Assets** | Cards · graded slabs · set indices, across Pokémon / One Piece / Magic |
| **Instrument** | Perpetual positions (long or short) with isolated-margin leverage |
| **Settlement** | Off-chain double-entry ledger; on-chain USDC custody |
| **Pricing** | Scrydex-anchored mark + tcgplayer/eBay cross-check + graded ladder |
| **Counterparty** | The shared liquidity pool (no order book) |

> **This is not financial advice.** Leverage means you can lose your entire deposit, fast. Read
> [Risk](#risk) before you trade.
