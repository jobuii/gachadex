# GachaDex CLI + SDK — Spec

Open-source command-line client and TypeScript SDK for GachaDex, usable by humans and by AI
agents (OpenClaw, Hermes, Claude Code, anything that runs a shell or speaks MCP). Distributed
on npm; developed in its own public repo.

**Status:** draft for review — nothing here is built yet. Code references are to this repo
(`apps/api/src/...`) and were verified against the source during review.

---

## Naming & where things live (decided)

| Thing | Name |
|---|---|
| GitHub org | `gachadex` |
| Public repo | `gachadex/cli` (monorepo: SDK + CLI) |
| CLI npm package (bin `gachadex`) | `gachadex` — so `npx gachadex …` works |
| SDK npm package | `@gachadex/sdk` |

`gachadex`, `@gachadex` (npm) and the `gachadex` GitHub org were all confirmed unclaimed on
2026-06-11. The private dex repo (this one) is untouched except for **Part 1** below.

The public repo knows only the REST/WS contract — nothing about custody internals, admin
routes, or operational thresholds may appear in its code or docs.

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

New table — note `users.id` is **TEXT** (app-generated UUID string, `schema.sql:63`), so the FK
is TEXT, not UUID:

```sql
CREATE TABLE IF NOT EXISTS delegated_keys (
  pubkey      TEXT PRIMARY KEY,          -- the delegate's ed25519 pubkey (base58)
  user_id     TEXT NOT NULL REFERENCES users(id),
  label       TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ,               -- NULL = no expiry (but keys create defaults to a cap, below)
  revoked_at  TIMESTAMPTZ                -- NULL = active; once set, the row is permanent (key burned)
);
CREATE INDEX IF NOT EXISTS idx_delegated_keys_user ON delegated_keys(user_id);
```

Two existing tables change. Both use the repo's established additive convention —
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` lines below the CREATE blocks (cf. `schema.sql:74-77`),
*not* edits inside a `CREATE IF NOT EXISTS` (which is a no-op on already-deployed DBs):

```sql
-- sessions must remember the scope/actor so refresh can't silently re-mint full scope
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS scope           TEXT NOT NULL DEFAULT 'full';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS delegate_pubkey TEXT REFERENCES delegated_keys(pubkey);
-- audit: who actually placed the order (the delegate), distinct from whose account it is
ALTER TABLE orders   ADD COLUMN IF NOT EXISTS actor_pubkey    TEXT;
-- (optional) auth_nonces purpose tag — see "Canonicalization" note; defense-in-depth only
ALTER TABLE auth_nonces ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'login';
```

Constraints: a pubkey is a delegate for at most one account (PRIMARY KEY); a pubkey that
already exists as `users.solana_pubkey` is rejected, **and** a pubkey present in
`delegated_keys` (active, expired, or revoked) is rejected at signup — see "Collision &
lifecycle". Active-key cap per account: `MAX_DELEGATED_KEYS` (default 4, operator-tunable;
Hyperliquid uses 1 unnamed + 3 named).

### Authorization flow (master wallet signs once)

Mirrors the existing nonce-message pattern (deterministic message, server re-renders at verify
time from the request body, single-use 5-minute nonce, atomic claim — `verifyNonceSignature`,
`auth.ts:105`):

1. `POST /auth/delegate/nonce` `{ pubkey, delegatePubkey, label?, expiresAt? }` →
   `{ nonce, message }`. Message (canonicalization pinned — see below):

   ```
   GachaDex trading-key delegation:
   <master pubkey>

   Statement: Authorize the key below to TRADE on this account. It can open and close
   positions but can NOT withdraw or transfer funds, and can be revoked at any time.
   Delegate: <delegate pubkey>
   Label: <label>
   Expires: <ISO-8601 UTC | never>
   Mode: <play-money | real-funds>
   Domain: <authDomain>
   Nonce: <nonce>
   ```

2. Master wallet signs (CLI signs with a local keyfile; web-app users get a one-time approval
   screen later — not required for v1).
3. `POST /auth/delegate` `{ pubkey, delegatePubkey, label?, expiresAt?, signature }` — server
   re-renders from the body, verifies ed25519 against the **master** pubkey, then **in one
   transaction with a row/advisory lock on the user**: enforces the active-key cap, the
   not-a-user and not-already-a-delegate checks, and inserts the row. (The lock closes the
   TOCTOU where two concurrent calls both pass the cap check.)

**Canonicalization (security-load-bearing).** The signature covers `delegatePubkey`/`label`/
`expiresAt`, so the nonce row need not store them — re-render from the body and verify. But the
rendering must be byte-exact and injection-proof: `label` is restricted to `[\x20-\x7E]{0,64}`
(printable ASCII, **no newlines** — a newline would let a crafted label forge `Delegate:`/
`Expires:` lines); `expiresAt` is echoed verbatim and validated as strict ISO-8601 UTC, must be
in the future, and is capped at `DELEGATE_MAX_TTL` (default 180 days — dYdX/Hyperliquid bound
agent validity rather than allowing `never`; `keys create` defaults to this, not `never`).
`Mode` binds the signature to play-money vs real-funds so an authorization can't be replayed
across deployments that share `AUTH_DOMAIN`; real-funds boot additionally requires a non-default
`AUTH_DOMAIN`.

Management (authenticated, **full scope only** — a delegate must never mint or revoke delegates):

- `GET /auth/delegates` → active + revoked keys with label/expiry/created.
- `POST /auth/delegates/:pubkey/revoke` → sets `revoked_at`.

Rate limits (new entries in `config.routeRateLimits`, mirroring the unauthenticated auth
surface): `delegateNonce` = 30/min, `delegateVerify` = 30/min (both are unauthenticated
DB-writes, same abuse profile as `authNonce`/`authVerify`).

### Login with a delegated key

No new login flow. The delegate uses the existing `POST /auth/nonce` + `POST /auth/verify` with
**its own pubkey**. The change is inside `verifyAndLogin` (`auth.ts:187`), and **order matters**:

1. After signature verification, **look up `delegated_keys` by the login pubkey first**, before
   `upsertUser`. If the pubkey is a delegate:
   - **active + unexpired + not revoked** → resolve to the master's `user_id`; create the
     session with `scope='trade'` and `delegate_pubkey=<pubkey>`; mint the access token with
     `scope:'trade'` and `act:<delegate pubkey>` claims. **Do not call `upsertUser`** (that
     would create the shadow user row that breaks everything).
   - **revoked or expired** → `401` (never fall through to user creation — that would mint a
     user row for the burned key and block re-delegation forever).
2. Otherwise it's a normal master login: `upsertUser` as today, `scope='full'`.

Master logins get `scope:'full'`; an absent claim still means full, so existing tokens keep
working. The `pubkey` claim is always the **account** (master) pubkey; `act` (when present) is
the delegate. `/auth/me` returns `{ id, pubkey, scope, act? }`.

### Scope on refresh (closes the escalation hole)

`refresh()` (`auth.ts:200`) currently re-mints purely from `sessions`+`users`, neither of which
knew about scope — so a literal implementation would silently upgrade a delegate's session to
full on first rotation. With the new `sessions.scope`/`delegate_pubkey` columns, refresh:

- reads `scope` + `delegate_pubkey` from the session row,
- if delegated, **re-checks `delegated_keys`** (still active, unexpired, unrevoked) — if not,
  `401` and revoke the family,
- re-mints with the same `scope` + `act`.

This makes revocation effective within **one access-token TTL** (`ACCESS_TTL_SEC`, default
15 min, env-tunable) for REST — provided the WS bound below is also fixed.

### Scope enforcement (fail-closed)

Invert the gate so new routes are safe by default: `authenticate` takes a `requiredScope`
option defaulting to `'full'`; trade-allowed routes opt in explicitly with `requiredScope:
'trade'`. A Part-1 test walks every authenticated route and asserts it declares a scope policy
(no silent fail-open as the API grows).

**Trade scope is allowed on:**

| Route | Method |
|---|---|
| `/orders`, `/positions/:id/close`, `/positions` | POST / POST / GET |
| `/account/balance` | GET |
| `/history/orders\|trades\|transactions\|positions` | GET |
| `/markets*` (public anyway) | GET |
| `/me/profile`, `/referral/me`, `/lp/position` | GET (read-only) |
| `/faucet` (play-money self-funding — agents need it) | POST |
| `/auth/me` | GET |

**Trade scope is rejected (403) on:** `/wallet/*` (custody; also real-funds-gated already),
`/lp/deposit`, `/lp/withdraw`, `/me/username`, `POST /chat`, `/referral/code`,
`/referral/redeem`, `/auth/delegate*`, and `/auth/logout` **wildcard mode** (see next).

`/auth/logout` with no `refreshToken` body revokes **all** of the account's sessions
(`auth.ts:233`) — a trade key must not be able to log the master out everywhere. Under trade
scope, logout may revoke only its own session (the JWT's `sid`) or sessions where
`delegate_pubkey = act`; the wildcard path is full-scope only.

### WebSocket scope + expiry (closes the indefinite-stream hole)

`ws.ts` verifies the token once at `{op:'auth'}` and never re-checks (`ws.ts:50-52`), so a
revoked delegate's open socket would stream the master's private channels forever — breaking the
15-min bound. Fix: record the token's `exp` at auth time and drop authed state (clear `userId`,
unsubscribe private channels) when it passes, forcing a re-auth. Private channels a trade-scoped
token may subscribe to: `positions`, `orders`, `balance`, `liquidations` (its own `userId`
only, as today). (`lp:` is declared but never published to — no action needed.)

### Collision & lifecycle (resolves former open questions)

- A pubkey in `delegated_keys` — **active, expired, or revoked** — can never become a `users`
  row (rejected in `verifyAndLogin` before `upsertUser`), and a pubkey that is a `users` row can
  never become a delegate.
- A **revoked delegate pubkey is burned forever**: re-authorizing it is rejected with a clear
  error (`delegate_revoked`). Rotation = generate a fresh keypair. (Re-arming a key that was
  revoked *because* it leaked, on one phished signature, is exactly the failure to avoid.)

### Order price protection + error codes (SDK prerequisites)

Two small API additions the SDK's 1.0 contract depends on:

1. **Optional `maxExecPriceE6` on `POST /orders`** (and the mirror for shorts), checked in-tx
   against the fill mark and rejected with a typed error. Fills are at the synthetic mark,
   which is clamped (premium ±`premium_cap_e6` ≈10%, anchor ±`max_dev_bps` ≈15%), so this is
   bounded-not-unbounded slippage — but at up to 20× a 10–20% adverse move between preview and
   fill can still wipe most of the margin. Agents should default to setting it. (This corrects
   the earlier "preview must match settlement" claim, which was overstated: parity is *math
   parity given identical inputs*, not a guarantee the mark won't move across the
   preview→submit gap.)
2. **Stable machine-readable error `code`** alongside the existing `{ error: '<prose>' }`
   (additive — `HttpError` gains a `code` slug; `setErrorHandler`, `server.ts:56`, emits it).
   Prose is rewordable and a frozen-at-1.0 SDK can't branch on it. Initial set:
   `insufficient_balance`, `market_halted`, `quantity_below_min`, `quantity_off_step`,
   `oi_cap_exceeded`, `scope_denied`, `delegate_revoked`, `delegate_cap_reached`,
   `nonce_expired`, `idempotency_conflict`, `slippage_exceeded`. Unknown → `unknown` + status.

Also add the **effective `feeBps`** to `GET /markets` output. Today the live fee is readable
only on the admin surface (`/admin/fee`) and the web client just hardcodes `OPEN_FEE_BPS=10`
(`OrderEntry.jsx:9`) while the server default is `0` — so no client has true fee parity and the
CLI can't preview a correct fee or required balance (the engine requires
`available >= margin + openFee`, `engine.ts:360`). Exposing it makes previews honest.

Minor: add an `apiVersion` field to `/health` (which already returns env/realFunds/time,
`server.ts:71`) so the SDK can warn "upgrade gachadex" on mismatch instead of failing
mysteriously. `minSdkVersion` is optional.

### Tests (Part 1 definition of done)

- Delegation message tamper / replay / expiry / cap / revoke; **label-newline injection** and
  `expiresAt` canonicalization; `Mode`/`Domain` cross-environment replay.
- Concurrent `/auth/delegate` cannot exceed the cap (lock holds).
- Delegated login issues trade scope for the master's account and **creates no user row**;
  revoked/expired delegate login → 401 (no shadow user); a delegate pubkey can never sign up,
  and vice versa.
- **Refresh of a delegated session keeps trade scope** and re-checks the delegate row (revoked →
  401 + family revoke).
- Route-walk test: every authenticated route declares a scope; every trade-denied route 403s a
  trade token; every allowed route works.
- WS: a token dropped at `exp` stops receiving private events; revoked delegate can't re-auth.
- Logout wildcard is rejected under trade scope.

---

## Part 2 — The public repo: `gachadex/cli`

### Repo shape

```
gachadex/cli
├── packages/
│   ├── sdk/        # @gachadex/sdk — typed client, zero CLI deps
│   └── cli/        # gachadex — bin, depends on @gachadex/sdk
├── skills/gachadex-trading/SKILL.md   # agent skill (OpenClaw / Hermes / Claude Code)
├── test/contract/  # recorded fixtures + mock server implementing the frozen contract
├── .github/workflows/   # CI: test + contract tests on PR; publish on tag (--provenance)
├── SECURITY.md          # reporting contact + scope (this tool handles wallet keys)
├── LICENSE              # MIT
└── README.md
```

Conventions (researched, current 2026-06): ESM-only, TypeScript, `engines.node >= 20`,
tsup-bundled single-file bin, **commander**, changesets for versioning, npm publish with
`--provenance` and publishing restricted to the CI workflow with 2FA-required maintainers
(supply-chain attestation matters — agent users will check, given the ClawHub wallet-stealer
incidents). A lockfile-audit step runs in CI.

### Isolation from the private repo

The SDK vendors the preview-math it needs (`notional`, `initialMargin`, `maintenanceMargin`,
`unrealizedPnl`, `liquidationPrice`, `fee`, `toE6`/`fromE6`, `formatUsd`) **plus a
qty-from-margin/leverage helper that floors to `qtyStepE6` and checks `minQtyE6`** — that
conversion is exactly where preview/settle drift would creep in (`engine.ts:296-297` reject
off-step/sub-min qty), so it must be vendored and covered by vectors, not improvised in the CLI.

Parity is enforced by a **golden test-vector file**: JSON input/output vectors generated by a
script in *this* repo from `@pokex/pricing`, committed to both repos; both suites assert against
it. The file carries a `mathVersion`; this repo's CI fails if `@pokex/pricing` changes without
regenerating (hash the inputs), and `/health` exposes `mathVersion` so the SDK can downgrade
previews to "indicative" on mismatch. **Owner of cross-repo regeneration: named in this repo's
CONTRIBUTING.** All money stays BigInt micro-units end to end (`MicroStr` wire format).

The public repo's integration tests don't depend on the private API: a small **mock server**
implements the frozen contract (including the error `code`s above) against recorded fixtures;
the same fixtures run in *this* repo's CI as the contract guard (enforcement teeth for the
additive-only promise). An optional job runs against a live staging URL from a repo secret.

### SDK design (`@gachadex/sdk`)

```ts
import { GachaDex, keypairSigner } from '@gachadex/sdk';

const dex = new GachaDex({ apiUrl });                  // public reads, no auth
const markets = await dex.markets();                   // id, symbol, feeBps, qtyStepE6, minQtyE6, maxLeverage
const candles = await dex.candles(marketId, '1M');     // tf: 1D|1W|1M|3M|1Y

const signer = keypairSigner(secretKey);               // or any { pubkey, sign(bytes) }
const session = await dex.login(signer);               // SIWS nonce → verify → JWT (auto-refresh)
await session.balance();
await session.openPosition({ marketId, side, qtyE6, leverage, maxExecPriceE6?, idempotencyKey });
await session.closePosition(positionId, { fractionBps, idempotencyKey });
await session.positions(); await session.history('trades', { limit, before? });

// master-key only:
await session.delegateKey({ delegatePubkey, label, expiresAt });
await session.revokeDelegate(pubkey);

const stream = dex.stream();                            // WS: auto-reconnect, re-auth, resubscribe
stream.subscribe(`mark:${marketId}`, fn);
stream.private(session, ['positions', 'liquidations'], fn);  // re-auths on reconnect before resub
```

Design points the review surfaced:

- **Signer abstraction** (`{ pubkey, sign(bytes): Promise<bytes> }`) for hardware/remote signers.
- **The SDK renders every signed message locally** from its own intent parameters (its pubkey,
  the delegate keypair *it* generated, its label/expiry) and only takes the `nonce` string from
  the server — it never blind-signs server-supplied text. This neutralizes a malicious/
  typosquatted `apiUrl` turning the non-interactive keyfile signer into a signing oracle
  (applies to login, delegation, and any future step-up).
- **Idempotency key is generated once at order construction and reused across transport
  retries** (a fresh key per retry would defeat the server's per-user dedupe,
  `uq_orders_user_idem`). The exit-4 envelope (below) carries the key so the re-run is the same
  logical order.
- **Token cache is lockfile-guarded** (single-flight across parallel CLI processes); on
  `refresh token reuse detected` (family revoked by the rotation race, `auth.ts:212`) the SDK
  silently re-logs-in from the signer rather than treating it as fatal.
- **WS reconnect sequence:** refresh if `exp` is near → `{op:'auth'}` → await `authed` → resub
  private then public; surface `authed {ok:false}` as a typed stream error.
- Errors are typed `GachaDexError { code, status, message, hint }`, `code` from the server slug.
- Symbol→id is resolved fresh from `dex.markets()` immediately before any mutation, and
  mutations always submit `marketId` (never a cached symbol).

### CLI design (`gachadex`)

```
gachadex login [--keyfile <path>]                # master login (needed only to manage keys)
gachadex keys create [--label bot1] [--expires 30d] [--master-keyfile <path>]
gachadex keys list | revoke <pubkey>
gachadex markets [--kind card|index] [--game pokemon] [--search <q>]   # filtered client-side
gachadex market <id|symbol>                      # resolved client-side from /markets
gachadex candles <market> [--tf 1D|1W|1M|3M|1Y]
gachadex balance
gachadex positions
gachadex long  <market> (--margin 100 --lev 5 | --qty 2.5) [--max-slippage 1] [--yes] [--dry-run]
gachadex short <market> …
gachadex close <positionId> [--fraction 50] [--yes]        # --fraction is percent → fractionBps
gachadex funding <market>                        # current/recent funding (funding: WS + history)
gachadex history (orders|trades|transactions|positions) [--limit N] [--before <cursor>]
gachadex faucet [--amount 10000]                 # play-money mode only
gachadex leaderboard
gachadex watch <market…>                         # public marks (WS)
gachadex events                                  # authenticated private stream: fills, liquidations
gachadex config (get|set) <key> [value]          # apiUrl, defaultKey, output
```

`--margin`+`--lev` converts to qty at the live mark via the vendored helper (floored to step,
checked against min); `--max-slippage` maps to `maxExecPriceE6`. `--fraction 50` → `5000` bps;
the CLI documents the engine's remainder behavior (verified against `engine.ts`) and uses a
fresh idempotency key per partial close.

**Agent-friendly conventions:**

- **TTY-aware output:** human tables on a TTY, **JSON when piped**; `--json` forces it. Data to
  stdout, logs/errors to stderr.
- **Typed exit codes:** `0` ok · `1` general · `2` auth · `3` validation · `4` confirmation
  required · `5` transient/retryable (429, 5xx, network — the SDK already honors `Retry-After`
  with capped jittered backoff; this code tells an agent to retry vs. give up).
- **Mutation gating:** `long`/`short`/`close`/`keys create` exit `4` with a JSON envelope
  describing exactly what would happen — including the **resolved `marketId`**, display name,
  and `idempotencyKey` — plus the exact re-run command (carrying `--idempotency-key`), unless
  `--yes`. `--dry-run` prints the preview and exits 0 without touching the API. Never an
  interactive prompt when non-TTY.
- **Mode awareness:** the CLI reads `realFunds` from `/health` at session start; in real-funds
  mode `faucet` fails with a purposeful message + `code` (the API returns 403,
  `faucet.ts:65`), and the README states wallet/deposit/withdraw are intentionally out of CLI
  v1 (withdrawals need master step-up signatures by design). Play-money `faucet` can also 429
  at the $1M cap (`faucet.ts:70`) — surfaced as a clear message, not a raw error.
- **Frozen surface at 1.0:** JSON field names and flags are additive-only after release.
- Honors `NO_COLOR`; no fuzzy "did you mean"; warns if local clock skew vs `/health.time`
  exceeds ~30s (nonces expire in 5 min).

### Key management & config

Precedence (each overrides the next):

1. `GACHADEX_KEY` env var — base58 secret key **or** a keyfile path. Headless/agent/CI path;
   never written to disk by us.
2. Keyfile at `~/.config/gachadex/keys/<name>.json`, chmod `0600`, **Solana CLI keyfile
   format** (the JSON byte array `solana-keygen` writes) so existing keys work; cf. Jupiter's
   `~/.config/jup/keys/`.
3. OS keychain, opt-in, via `@napi-rs/keyring` (keytar is dead; keychains don't exist in
   containers, so this can't be the default).

`GACHADEX_API_URL` overrides the endpoint. Refresh tokens cache in `~/.config/gachadex/` at
`0600`, lockfile-guarded. The happy path stores **only delegated trade-only keys**; `keys
create` is the front door, and `login --keyfile` (master) is needed only for delegation
management. Config-dir resolution via `env-paths` (XDG-correct per OS). README threat-model
section: delegated keys are the happy path; the master keyfile is used only for `keys create`
and should never be placed in `GACHADEX_KEY`.

### SKILL.md (agent distribution)

One skill file, agentskills.io format (works in OpenClaw, Hermes, Claude Code): frontmatter
(`name: gachadex-trading`, description) + body covering: install (`npm i -g gachadex`),
authenticate via `GACHADEX_KEY` (a delegated key), `--json` output + exit codes (especially the
`4`→re-run-with-`--yes` confirmation protocol and `5`→retry), the idempotency-key retry rule,
defaulting `--max-slippage`, and using `events` for liquidation alerts. An MCP server is
**out of v1** — it can arrive later as a `gachadex mcp` stdio subcommand wrapping the same SDK
calls, without breaking anything.

---

## Phases

| Phase | Where | Scope |
|---|---|---|
| **0** | this repo, branch `feat/delegated-keys` | `delegated_keys` table + sessions/orders/nonce ALTERs; delegation routes (+RL); scoped JWTs with correct lookup order; refresh scope re-check; fail-closed scope gate + route-walk test; WS expiry/scope; logout gating; `maxExecPriceE6`; error `code`s; `feeBps`+`apiVersion`+`mathVersion` on responses; full test set above |
| **1** | new `gachadex/cli` repo | scaffold (org, repo, CI, SECURITY.md, license); SDK: reads + SIWS login + trade + delegate mgmt + local message rendering + lockfile token cache; golden parity vectors + qty helper; contract mock server |
| **2** | `gachadex/cli` | CLI commands, key storage, agent conventions (exit codes, mode awareness), `watch`/`events` (WS), SKILL.md |
| **3** | `gachadex/cli` | npm publish with provenance (`gachadex` + `@gachadex/sdk`), README/threat-model/docs, optional ClawHub listing |
| later | `gachadex/cli` | `gachadex mcp` stdio subcommand; web-app UI for approving delegations from Phantom; `before`-cursor pagination on `/history/*` if not done in Phase 0 |

Phase 0 merges and deploys before Phase 2 ships anything needing auth (the SDK's public reads in
Phase 1 work against the current API already).

## Resolved during review

- Lookup order, shadow-user, and collision rules are now specified (delegate check before
  `upsertUser`; delegate pubkeys never become users; revoked = burned).
- Refresh scope escalation closed via `sessions.scope`/`delegate_pubkey`.
- WS indefinite-stream closed via `exp` enforcement.
- Logout wildcard gated; scope gate inverted to fail-closed.
- Fee parity claim corrected; `feeBps` now exposed.
- `users.id` FK type corrected to TEXT.
- **Refuted (no change):** a nonce `purpose` column isn't required — flows are cryptographically
  separated because the server re-renders a purpose-specific message and the three templates
  have distinct fixed first lines, so a signature over one never verifies as another (the column
  is kept above only as cheap defense-in-depth/clearer errors). The `lp:` WS channel has no
  publisher. Market symbols are `UNIQUE` and delisted rows are retained, so a stale symbol
  resolves to a 404, never a different market (the CLI still resolves fresh + submits by id).

## Open questions (need your call; none block Phase 0 design)

1. **Faucet under trade scope** — allowed so play-money agents can self-fund; flip to full-only
   if abuse appears.
2. **`DELEGATE_MAX_TTL`** — proposed 180 days; and **`MAX_DELEGATED_KEYS`** — proposed 4.
3. **License** — MIT proposed; Apache-2.0 if a patent grant matters.
4. **History pagination** — add `before` cursor in Phase 0, or fast-follow (CLI exposes
   `--before` from day one regardless; additive on the server).
