# API & CLI

**Trade by code, safely.** GachaDex exposes a REST + WebSocket API and ships an official CLI / SDK — all
gated by **scoped, revocable keys** so a bot never touches your withdrawal rights.

## Delegated keys

A full-scope wallet authorizes a fresh **delegated key** (by signing a message) that receives a
**`trade`-scoped** session token. It can open and close positions but can **never** withdraw or manage
identity. Keys are capped per account, time-bounded, and revocable (the pubkey is burned on revoke). This is
how bots and the CLI trade without your main key.

## The CLI / SDK

The official `gachadex` CLI and `@gachadex/sdk` wrap the API: connect with a delegated key, list and search
markets, open/close positions, stream live marks, and read your portfolio — scriptable end to end.

## The API surface

- **Public reads** — markets, candles, the index overview, the leaderboard, chat.
- **Authenticated (trade scope)** — open/close positions, search-and-bet listing, and resting orders (gated;
  ship dark behind a flag).
- **Authenticated (full scope)** — deposits / withdrawals, identity, delegated-key management.
- **WebSocket** — live marks, the pool's long/short skew, and chat are pushed over channels (the browser is
  just a renderer; everything is server-authoritative).

All money values cross the wire as integer **micro-USDC** strings (`*_e6`) — JSON has no BigInt, so amounts
are decimal strings parsed back to integers.

> Building on GachaDex? Mint a **trade-scoped** key, never your full wallet — and treat the `e6` integers as
> the source of truth, never a float.
