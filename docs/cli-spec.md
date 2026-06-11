# GachaDex CLI + SDK — Spec

Open-source command-line client and TypeScript SDK for GachaDex, usable by humans and by AI
agents (OpenClaw, Hermes, Claude Code, anything that runs a shell or speaks MCP). Distributed
on npm; developed in its own public repo.

**Status:** draft for review — nothing here is built yet.

---

## Naming & where things live (decided)

| Thing | Name |
|---|---|
| GitHub org | `gachadex` |
| Public repo | `gachadex/cli` (monorepo: SDK + CLI) |
| CLI npm package (bin `gachadex`) | `gachadex` — so `npx gachadex …` works |
| SDK npm package | `@gachadex/sdk` |

The private dex repo (this one) is untouched except for **Part 1** below: the delegated-key
API the CLI authenticates with. The public repo knows only the REST/WS contract — nothing
about custody internals, admin routes, or operational thresholds may appear in its code or docs.

---

## Part 1 — Dex-side prerequisite: delegated trading keys (this repo)

### Why

Every major perp dex ships trade-only delegated keys (Hyperliquid "API/agent wallets", dYdX
"permissioned keys", Drift "delegated accounts"): the master wallet authorizes a fresh keypair
that can trade but never move funds. Without this, every bot/agent integration means handing
over the real wallet key. With it, a leaked agent key caps the damage at "bad trades until
revoked."

GachaDex already has the strongest half of this: withdrawals require a **fresh master-wallet
signature over the exact amount + destination** (`buildWithdrawalMessage`,
`apps/api/src/services/auth.ts`), so no bearer token alone can move funds. Delegated keys add
the missing half: a credential agents can hold that is *also* scope-limited at the route layer.

### Data model

New table (idempotent, in `apps/api/src/db/schema.sql`):

```sql
CREATE TABLE IF NOT EXISTS delegated_keys (
  pubkey      TEXT PRIMARY KEY,          -- the delegate's ed25519 pubkey (base58)
  user_id     UUID NOT NULL REFERENCES users(id),
  label       TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ,               -- NULL = no expiry
  revoked_at  TIMESTAMPTZ                -- NULL = active
);
CREATE INDEX IF NOT EXISTS idx_delegated_keys_user ON delegated_keys(user_id);
```

A pubkey can be a delegate for at most one account (PRIMARY KEY), and a pubkey that already
exists as a `users.pubkey` must be rejected at authorization time (no aliasing a real account
into a delegate). Active-key cap per account: `MAX_DELEGATED_KEYS` config knob (Hyperliquid
allows 1 unnamed + 3 named; we pick a single cap, default proposed 4, operator-tunable).

### Authorization flow (master wallet signs once)

Mirrors the existing nonce-message pattern exactly (deterministic message, server re-renders
at verify time, single-use 5-minute nonce, atomic claim):

1. `POST /auth/delegate/nonce` `{ pubkey, delegatePubkey, label?, expiresAt? }` →
   `{ nonce, message }` where the message is:

   ```
   GachaDex trading-key delegation:
   <master pubkey>

   Statement: Authorize the key below to TRADE on this account. It can open and close
   positions but can NOT withdraw or transfer funds, and can be revoked at any time.
   Delegate: <delegate pubkey>
   Label: <label>
   Expires: <ISO timestamp | never>
   Domain: <authDomain>
   Nonce: <nonce>
   ```

2. Master wallet signs the message (CLI signs with a local keyfile; web-app users get a
   one-time approval screen later — not required for v1).
3. `POST /auth/delegate` `{ pubkey, delegatePubkey, label?, expiresAt?, signature }` —
   server re-renders, verifies ed25519 against the **master** pubkey, enforces the cap and
   the not-a-user check, inserts the row.

Management (authenticated, **full scope only**):

- `GET /auth/delegates` → active + revoked keys with label/expiry/created.
- `POST /auth/delegates/:pubkey/revoke` → sets `revoked_at`.

### Login with a delegated key

No new login flow. The delegate uses the existing `POST /auth/nonce` + `POST /auth/verify`
with **its own pubkey**. `verifyAndLogin` gains one lookup: if the pubkey is an active,
unexpired, unrevoked delegate, issue the JWT for the **master's** `userId` with:

- `scope: 'trade'` claim (master logins get `scope: 'full'`; absent claim = full, so existing
  tokens keep working),
- `act: <delegate pubkey>` claim (actor, for audit),
- refresh tokens carry the same scope; **refresh re-checks the delegate row**, so revocation
  takes effect within one access-token TTL (15 min) at worst.

### Scope enforcement

`authenticate` (`apps/api/src/plugins/auth.ts`) sets `req.scope`; a `requireFullScope`
preHandler gates routes. Trade scope **allows**: `/orders`, `/positions*`, `/account/balance`,
`/markets*` (public anyway), `/history/*`, `/faucet` (play-money funding — agents need it),
`/auth/me`, `/auth/logout`, private WS channels. Trade scope is **rejected** by:

| Route | Reason |
|---|---|
| `/wallet/withdraw/nonce`, `/wallet/withdraw` | moving funds (already step-up-protected; belt and braces) |
| `/wallet/deposit-address`, `/wallet/transactions` | custody surface, not needed to trade |
| `/lp/deposit`, `/lp/withdraw` | moving funds between roles |
| `/me/username`, `/chat` POST | identity/impersonation surface |
| `/referral/code`, `/referral/redeem` | account-level identity actions |
| `/auth/delegate*` | a delegate must not mint or revoke delegates |

Audit (small, do in v1): record the actor on writes — add `actor_pubkey TEXT` to the orders
table, populated from the `act` claim when present.

### Tests (Part 1 definition of done)

- Delegation message tamper / replay / expiry / cap / revoke paths.
- Delegated login issues trade scope for the master's account; revoked/expired keys can't log
  in; refresh after revocation fails.
- Every gated route returns 403 for a trade-scoped token; every allowed route works.
- A delegate pubkey colliding with an existing user pubkey is rejected, and vice versa
  (a delegate pubkey cannot later sign up as its own user — decide: reject at signup).

---

## Part 2 — The public repo: `gachadex/cli`

### Repo shape

```
gachadex/cli
├── packages/
│   ├── sdk/        # @gachadex/sdk — typed client, zero CLI deps
│   └── cli/        # gachadex — bin, depends on @gachadex/sdk
├── skills/gachadex-trading/SKILL.md   # agent skill (OpenClaw / Hermes / Claude Code)
├── .github/workflows/   # CI: test on PR; publish on tag with npm --provenance
├── LICENSE              # MIT
└── README.md
```

Conventions (researched, current as of 2026-06): ESM-only, TypeScript, `engines.node >= 20`,
tsup-bundled single-file bin, **commander** for the CLI, changesets for versioning, npm
publish with `--provenance` (supply-chain attestation — agent users will check, given the
ClawHub wallet-stealer incidents). SDK dual-publishes types; CLI is bin-only.

### Isolation from the private repo

The SDK vendors the handful of preview-math functions it needs (`notional`, `initialMargin`,
`maintenanceMargin`, `unrealizedPnl`, `liquidationPrice`, `fee`, `toE6`/`fromE6`,
`formatUsd`) rather than importing `@pokex/pricing`. Parity is enforced by a **golden
test-vector file**: a JSON of input/output vectors generated by a script in *this* repo from
`@pokex/pricing`, committed to both repos; both test suites assert against it. Regenerate
whenever the math changes. All money stays BigInt micro-units end to end, exactly like the API
(`MicroStr` wire format).

### SDK design (`@gachadex/sdk`)

```ts
import { GachaDex, keypairSigner } from '@gachadex/sdk';

const dex = new GachaDex({ apiUrl });                  // public reads, no auth
const markets = await dex.markets();
const candles = await dex.candles(marketId, '1M');

const signer = keypairSigner(secretKey);               // or any { pubkey, sign(bytes) }
const session = await dex.login(signer);               // SIWS nonce → verify → JWT (auto-refresh)
await session.balance();
await session.openPosition({ marketId, side: 'long', qtyE6, leverage, idempotencyKey });
await session.closePosition(positionId, { fractionBps });
await session.positions(); await session.history('trades');

// master-key only:
await session.delegateKey({ delegatePubkey, label, expiresAt });
await session.revokeDelegate(pubkey);

// realtime (WS): public mark/oi/stats/funding channels + private channels after ws-auth
const stream = dex.stream();
stream.subscribe(`mark:${marketId}`, (m) => ...);
```

Design points:

- **Signer abstraction** (`{ pubkey, sign(bytes): Promise<bytes> }`) so hardware/remote
  signers can slot in later without API changes.
- Single-flight token refresh on 401 (mirror the web client's behavior).
- Idempotency keys auto-generated when not supplied (the API already dedupes on them).
- Errors are typed (`GachaDexError { code, status, message, hint }`).
- WS client: auto-reconnect with backoff, resubscribe on reconnect, `{op:'auth', token}` for
  private channels — same protocol as `apps/web/src/lib/ws.js`.

### CLI design (`gachadex`)

Command surface (v1):

```
gachadex login [--keyfile <path>]                # master login (only needed to manage keys)
gachadex keys create [--label bot1] [--expires 30d] [--master-keyfile <path>]
                                                 # generate delegate locally + authorize in one step
gachadex keys list | revoke <pubkey>
gachadex markets [--kind card|index] [--game pokemon] [--search <q>]
gachadex market <id|symbol>                      # details
gachadex candles <market> [--tf 1D|1W|1M|3M|1Y]
gachadex balance
gachadex positions
gachadex long  <market> (--margin 100 --lev 5 | --qty 2.5) [--yes] [--dry-run]
gachadex short <market> …                        # same flags
gachadex close <positionId> [--fraction 50] [--yes]
gachadex history (orders|trades|transactions|positions)
gachadex faucet [--amount 10000]                 # play-money mode
gachadex leaderboard
gachadex watch <market…>                         # stream live marks (WS)
gachadex config (get|set) <key> [value]          # apiUrl, defaultKey, output
```

`--margin` + `--lev` converts to qty at the live mark using the vendored math, and the
pre-trade preview (entry, notional, fee, liq price) must match what the engine settles —
same parity guarantee the web client has.

**Agent-friendly conventions** (these are the point of the project):

- **TTY-aware output**: human tables when stdout is a TTY, **JSON when piped**; `--json`
  forces it. Data to stdout, logs/errors to stderr.
- **Typed exit codes**: `0` ok · `1` general · `2` auth · `3` validation · `4` confirmation
  required.
- **Mutation gating**: `long`/`short`/`close`/`keys create`/`lp` exit `4` with a JSON
  envelope describing exactly what would happen and the re-run command, unless `--yes`.
  `--dry-run` prints the preview and exits 0 without touching the API. Never an interactive
  prompt when non-TTY.
- **Frozen surface at 1.0**: JSON field names and flags are additive-only after release.
- Honors `NO_COLOR`; no fuzzy "did you mean" auto-correction.

### Key management & config

Precedence (each overrides the next):

1. `GACHADEX_KEY` env var — base58 secret key **or** a path to a keyfile. The headless
   agent/CI path; never written to disk by us.
2. Keyfile at `~/.config/gachadex/keys/<name>.json`, chmod `0600`, **Solana CLI keyfile
   format** (the JSON byte array `solana-keygen` writes) so existing keys just work.
3. OS keychain, opt-in, via `@napi-rs/keyring` (keytar is dead; keychains don't exist in
   containers, so this can't be the default).

`GACHADEX_API_URL` overrides the configured endpoint. Refresh tokens cache in
`~/.config/gachadex/` at `0600`. The happy path stores **only delegated trade-only keys**;
`gachadex keys create` is the front door, and `login --keyfile` (master) is needed only for
delegation management. Config dir resolution via `env-paths` (XDG-correct per OS).

### SKILL.md (agent distribution)

One skill file in the repo, agentskills.io format (works in OpenClaw, Hermes, and Claude
Code): frontmatter (`name: gachadex-trading`, description) + body that tells the agent to
install via `npm i -g gachadex`, authenticate via `GACHADEX_KEY`, and use `--json` + exit
codes; documents the confirmation protocol (exit 4 → re-run with `--yes`). Optionally
published to ClawHub later. An MCP server is **explicitly out of v1** — it can arrive later
as a `gachadex mcp` subcommand wrapping the same SDK calls without breaking anything.

---

## Phases

| Phase | Where | Scope |
|---|---|---|
| **0** | this repo, branch `feat/delegated-keys` | table, delegation routes, scoped JWTs, route gating, actor audit column, tests |
| **1** | new `gachadex/cli` repo | scaffold (org, repo, CI, licenses), SDK: reads + SIWS login + trade + delegate mgmt, golden parity vectors |
| **2** | `gachadex/cli` | CLI commands, key storage, agent conventions, `watch` (WS), SKILL.md |
| **3** | `gachadex/cli` | npm publish with provenance (`gachadex` + `@gachadex/sdk`), README/docs, optional ClawHub listing |
| later | `gachadex/cli` | `gachadex mcp` stdio subcommand; web-app UI for approving delegations from Phantom |

Phase 0 merges and deploys before Phase 2 ships anything that needs auth (the SDK's public
reads in Phase 1 work against the current API already).

## Open questions

1. **Faucet under trade scope** — allowed above so play-money agents can self-fund; flip to
   full-only if faucet abuse becomes a concern.
2. **Delegate-pubkey/user-pubkey collision policy** — spec says reject both directions;
   confirm we also want to block signup for pubkeys that exist as delegates.
3. **Default `MAX_DELEGATED_KEYS`** — proposed 4; operator-tunable either way.
4. **License** — MIT proposed for the public repo; Apache-2.0 if patent grant matters to you.
5. **Cross-repo schema duplication** — the SDK re-declares request/response shapes (zod).
   Acceptable drift risk for v1 (the golden vectors cover the money math); revisit publishing
   `@gachadex/types` if the surface grows.
