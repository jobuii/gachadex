# FAQ

**Do I need real money to start?**
No. Play-money mode gives you a faucet to learn the mechanics risk-free. Real USDC is opt-in via a deposit.

**Is this on-chain?**
Custody is — deposits and withdrawals run on Solana with per-user addresses and proof-of-reserves. *Trading*
settles on an off-chain double-entry ledger for instant, gas-free fills. See [Custody & Security](#custody).

**Am I buying actual cards?**
No. You trade **price exposure** — long or short — to a card, a graded slab, or an index. No card ever ships.

**What can I trade?**
Single cards, graded slabs, and set [indices](#indices), across Pokémon, One Piece, and Magic. Don't see a
card? [Search the catalogue](#markets) and list it on demand.

**How is the price set?**
A canonical mark anchored to the TCGplayer market (via Scrydex) with an eBay cross-check and a graded ladder,
adjusted by a small skew premium. See [Pricing & Oracle](#oracle).

**What's the difference between GJ, G&P, and Pokedaq?**
Three index methodologies over the same baskets — price-weighted (Dow), equal-weight (S&P), and capped-weight
(Nasdaq). See [The Indices](#indices).

**Can I get liquidated?**
Yes — if the mark moves against you enough to exhaust your margin. Your liquidation price is shown live;
lower leverage keeps it further away. See [Risk](#risk).

**How do LPs earn — and can they lose?**
LPs are the counterparty: they earn fees, funding, and traders' net losses, and they wear traders' net wins.
It isn't a Ponzi — your principal returns at the share price; the risk is market risk. See [Liquidity
Pool](#lp).

**Can I trade with a bot?**
Yes — mint a **trade-scoped** [delegated key](#api) that can't withdraw, and use the `gachadex` CLI / SDK.

**Is GachaDex affiliated with Pokémon / One Piece / Magic?**
No. GachaDex trades price exposure and is not affiliated with Nintendo / The Pokémon Company, Bandai, or
Wizards of the Coast.
