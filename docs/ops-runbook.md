# Operator runbook — real-funds custody

How to operate withdrawals, freezes and the treasury on a running deployment. Pairs with
`docs/real-funds-custody-plan.md` (design) and `docs/security-notes.md` (findings/decisions).

## Setup

The `/admin` routes exist only when **both** are set:

- `REAL_FUNDS=true` (plus the custody env it requires)
- `ADMIN_API_KEY=<32+ chars of real entropy>` — e.g. `openssl rand -hex 32`

Every request carries the key in the `x-admin-key` header (timing-safe compare, rate-limited
via `RL_ADMIN`, default 30/min/IP). Without `ADMIN_API_KEY` the routes are **unregistered**
(404), not merely unauthorized. Payout signing stays on the server — the operator key never
grants access to the hot-wallet secret.

```bash
API=https://api.example.com
AUTH="x-admin-key: $ADMIN_API_KEY"
```

## Day-to-day: the withdrawal queue

Withdrawals ≤ `WITHDRAWAL_AUTO_APPROVE_MAX_USD` (default $1k) pay out automatically when
`WITHDRAWAL_AUTO_PROCESS=true`. Everything larger sits **debited** in `requested` until you act.

```bash
# the actionable queue (already debited; waiting for your judgment)
curl -s -H "$AUTH" "$API/admin/withdrawals" | jq

# other lifecycles: ?status=signed|broadcast|confirmed|failed|reversed
curl -s -H "$AUTH" "$API/admin/withdrawals?status=confirmed" | jq

# approve: sign + broadcast one withdrawal (the manual path ignores the auto cap — your
# explicit judgment IS the approval)
curl -s -X POST -H "$AUTH" "$API/admin/withdrawals/<id>/approve" | jq

# reverse: re-credit a withdrawal that provably never paid out ('requested' rows always;
# signed/broadcast rows only when the signed tx is dead on-chain — the server verifies)
curl -s -X POST -H "$AUTH" -H 'content-type: application/json' \
  -d '{"reason":"user requested cancellation"}' \
  "$API/admin/withdrawals/<id>/reverse" | jq
```

A crash mid-payout self-heals: boot recovery re-broadcasts the persisted signed tx (same
signature — idempotent) and re-signs only when the original is provably dead.

## Treasury & proof of reserves

```bash
# read-only: PoR numbers, hot/cold/unswept balances, pending payouts, shortfall, freeze state
curl -s -H "$AUTH" "$API/admin/treasury" | jq
```

- **`breached: true`** — on-chain custody < ledger liabilities. The treasury worker will have
  auto-frozen withdrawals (or will within `TREASURY_PASS_MS`). This is an incident: find the
  discrepancy (missed deposit credit? treasury outflow?) before unfreezing.
- **`shortfallE6 > 0`** — pending payouts exceed the hot wallet. Normally deposits keep the hot
  float funded; a shortfall means withdrawals outran deposits. Top up hot from cold (a manual
  multisig transaction — the server cannot sign for cold) and re-check.
- **Hot float is a band.** Deposits sweep *into* the hot wallet (it funds withdrawals), so the float
  self-replenishes. Once the hot balance reaches `HOT_WALLET_MAX_USD` (the cap), the pass drains it
  back down to the floor — `HOT_WALLET_FLOOR_PCT`% of the cap — sweeping the excess to cold (never
  below queued payouts). So hot oscillates floor..cap and cold→hot top-ups are only needed if
  withdrawals outrun deposits.

## Freeze / unfreeze

A proof-of-reserves breach freezes withdrawals automatically. **Nothing unfreezes them
automatically** — that's yours, after the incident is understood:

```bash
curl -s -X POST -H "$AUTH" -H 'content-type: application/json' \
  -d '{"reason":"investigating deposit discrepancy"}' "$API/admin/freeze" | jq

curl -s -X POST -H "$AUTH" "$API/admin/unfreeze" | jq
```

While frozen: new withdrawal requests and new payout signings return 503; deposits continue;
recovery of already-signed payouts proceeds (those debits are final and re-broadcast is
idempotent).

## Insurance fund

Absorbs liquidation bad debt before it reaches LPs. It fills automatically from the 1% liquidation
penalty; you can also top it up from house money.

```bash
# current insurance balance
curl -s -H "$AUTH" "$API/admin/insurance" | jq

# allocate accumulated platform fees -> insurance (amounts are micro-USDC; 500000000 = 500 USDC)
curl -s -X POST -H "$AUTH" -H 'content-type: application/json' \
  -d '{"amountUusdc":"500000000"}' "$API/admin/insurance/from-fees" | jq
curl -s -X POST -H "$AUTH" -H 'content-type: application/json' \
  -d '{"amountUusdc":"500000000"}' "$API/admin/insurance/to-fees" | jq

# allocate treasury surplus (USDC sent to the treasury, above liabilities) -> insurance
curl -s -X POST -H "$AUTH" -H 'content-type: application/json' \
  -d '{"amountUusdc":"1000000000"}' "$API/admin/insurance/from-treasury" | jq
```

`from-treasury` is capped at the LIVE on-chain surplus — you can't allocate USDC you haven't actually
sent to the treasury wallet. All of these are also in the admin panel.

## Custody limits

Hot-wallet cap, withdrawal caps, minimums, and swap slippage are tunable **live** (no redeploy);
overrides persist in the `settings` table and overlay the env/`config.ts` defaults.

```bash
# current effective values + the config defaults
curl -s -H "$AUTH" "$API/admin/custody-limits" | jq

# update any subset (USD as plain dollars; swapSlippageBps as bps). Omitted keys are unchanged.
curl -s -X POST -H "$AUTH" -H 'content-type: application/json' \
  -d '{"hotWalletMaxUsd":50000,"withdrawalDailyCapUsd":25000,"swapSlippageBps":75}' \
  "$API/admin/custody-limits" | jq
```

Keys: `hotWalletMaxUsd`, `hotWalletFloorPct`, `withdrawalDailyCapUsd`, `withdrawalAutoApproveMaxUsd`,
`minWithdrawalUsd`, `minDepositUsd`, `minSweepUsd`, `swapSlippageBps`. `hotWalletFloorPct` is the
percent of the cap to leave in hot when draining to cold (e.g. cap 5000 + floor 20 → drain to $1,000,
sweep the rest). The admin panel exposes the same fields. A change applies on the next worker pass /
request and propagates to other API instances within ~30s.

## What can go wrong

| Symptom | Meaning | Action |
|---|---|---|
| approve → `409 withdrawal is confirmed` | already paid | nothing |
| approve → `503 withdrawals are temporarily frozen` | freeze active | resolve + unfreeze first |
| reverse → `409 signed tx is pending/confirmed on-chain` | the payout can still/already land(ed) | wait for recovery or confirmation; never force |
| treasury `breached: true` but `frozen: null` | breach between worker passes | freeze manually, then investigate |
| queue row stuck in `signed`/`broadcast` | broadcast failing | check RPC health; boot recovery retries on restart |
