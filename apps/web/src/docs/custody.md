# Custody & Security

**Real USDC, handled carefully.** In real-funds mode, GachaDex custodies deposits with on-chain rails and a
reconciling ledger — not an IOU spreadsheet.

## How custody works

- **Per-user deposit addresses.** Each account gets its own Solana address; deposits are **swept** into
  custody and credited to your balance.
- **Withdrawals.** Request one any time — the operator runs them manually or with a capped auto-approve. Your
  funds, your exit.
- **Hot / cold treasury + proof-of-reserves.** Custody is split hot/cold, with **proof-of-reserves** and an
  **auto-freeze** that halts **withdrawals** (deposits keep flowing) if reserves ever fail a check.
- **Insurance fund.** Backstops bad debt before it can touch the liquidity pool.
- **Live custody limits** (per-transaction and aggregate) are operator-tunable.

## Settlement: the ledger

Trading settles on an **off-chain double-entry ledger** — every fee, fill, funding payment, and liquidation
is a balanced transaction, so the whole system reconciles to the cent. That's how GachaDex prices off a live
oracle and settles instantly without an on-chain transaction per trade; the **on-chain part is the money
custody** (deposits and withdrawals).

## Delegated trading keys

You never have to expose your main wallet to a bot. Mint a **delegated key** — a fresh key with a
**trade-only** scope that can open and close positions but can **never** withdraw or manage your identity.
Keys are capped, time-bounded, and revocable. See [API & CLI](#api).

## Operator responsibilities

Real money on mainnet additionally requires the operator to put a security audit, KYC/AML, and geofencing in
place — the code gates on an explicit mainnet flag but does not itself verify those.
