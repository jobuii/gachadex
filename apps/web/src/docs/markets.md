# Markets

**Anything with a price, you can trade.** GachaDex lists three kinds of market across three games — and if a
card isn't listed yet, you can list it yourself.

## What you can trade

- **Single cards.** Individual card markets — modern chase cards, vintage classics, promos, alt arts —
  priced off the live oracle.
- **Graded slabs.** Pokémon graded markets priced from a full **PSA / BGS / CGC** ladder (see [Pricing &
  Oracle](#oracle)), not a single noisy sale.
- **Indices.** Whole-set and top-N baskets in three methodologies (GJ / G&P / Pokedaq) — the headline
  product. See [The Indices](#indices).

## Three games, one book

Pokémon, One Piece, and Magic markets sit side by side. The **Markets** page has an **Indices | Cards**
toggle and a per-game filter; the sidebar carries a game switcher. Indices are grouped per game, then per
series.

## Search-and-bet: list any card

Don't see a card? **Search the catalogue** and trade it on demand — the first time a card is requested, a
real, tradeable market is created from the provider's data (idempotent: an existing market is returned, never
duplicated). The official CLI and scoped bot keys can list markets too.

## Market status

A market can be:

- **Active** — tradeable, long or short.
- **Close-only** — you can exit but not open, usually while data is still flowing.
- **Gated** — defined but not yet live (e.g. the Sealed indices, which wait on a sealed-product price feed).

Indices light up automatically once their data flows — no manual flip.

## Reading a market

Each market shows the live **mark** (the tradeable price), **24h %**, and **volume**, plus a price chart. A
details panel surfaces rarity, set, and release year — and for graded cards, the full grade ladder.
