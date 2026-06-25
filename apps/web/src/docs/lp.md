# Liquidity Pool

**Be the house.** There's no order book on GachaDex — the **liquidity pool** takes the other side of every
trade. Provide liquidity and you earn the fees, funding, and net PnL that traders give up; you also wear
their net winnings when they're right.

## How LPs make money

Deposit into the pool and you own a share of it. The pool collects:

- a share of every **trading fee**,
- a share of **funding**,
- a share of **liquidation penalties**, and
- the **net realized PnL of all traders** — when traders lose on net, the pool gains; when they win on net,
  the pool pays.

Your stake rises and falls with the pool's **net asset value (NAV)**. The Pool page shows the share price,
total fees earned, and an APY from a published snapshot.

## Is it a Ponzi? No.

A fair question — the honest answer:

- **Your principal isn't paying anyone's yield.** Deposits sit in the pool as collateral. Returns come from
  *real fees* and from traders' *net losses* — external money, not new-depositor money.
- **You get your principal back** (plus your share of fees) on withdrawal, priced at the current share
  price — **early LPs don't take from later LPs.** A new depositor simply buys in at the live share price and
  earns a share of *future* flows.
- **The only way to lose principal is if traders win, net, by more than the fees you collected** — the real
  risk of being the house. That's market risk, not a structural one.

## The risks (be the house with eyes open)

- **Net trader PnL can go against you.** A run of winning traders draws the pool down; fees + funding +
  penalties are your edge, not a guarantee.
- **Bad debt** from a gap move is socialized to the pool — the insurance fund cushions it first.
- Pool-protection rails — adaptive depth, NAV-relative open-interest caps, a pool-health gate, and ADL —
  cap how much risk the pool can take on at once.

## Configurable economics

Operators tune each **LP / house split** (trading fees / funding / liquidations) and publish the pool's
display numbers — see [Fees & Funding](#fees).
