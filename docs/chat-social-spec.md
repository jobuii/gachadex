# Chat & social layer — spec

Turning the left-rail chat from a plain message list into the platform's social/engagement engine:
live action bars, reactions, identity/rank, presence, moderation, the **DROP** giveaway, and a
readability/visual redesign. Blends crypto-casino chat energy (Stake/flip.gg/collectoroll) with
perp-DEX flexing (Hyperliquid).

**Visual references** (do in OUR style, not copied): `references/flipgg-rain-bar.png` (the DROP bar),
`references/collectoroll-chat.png` (green win bar + gold bet bar, ONLINE count, MOD chip).

## Current baseline
Global live chat (`ChatSidebar.jsx` + `store/chat.js`, server `services/chat.ts`): messages with
color-initial avatars, @mentions, reply/quote, username editing, unread badge, 280-char cap,
rate-limited posting. Realtime via the WS `chat` channel (`publish('chat','message',msg)` → client
subscribes `['chat']`). Reused throughout.

## Architecture (reuse what exists)
- **Transport:** all features ride the existing `chat` WS channel with new `type`s: `message` (today),
  `event` (action bars), `reaction`, `delete`, `presence`, `drop`. No new socket plumbing.
- **History:** action bars persist as `chat_messages` rows (`kind='event'` + `meta` JSONB) so scroll-back
  shows recent wins; reactions can apply to them too.
- **Author metadata** (rank badge, level, MOD) rides on each outgoing chat payload from a periodically
  refreshed in-memory map (F4) — never recomputed per message.

---

## F1 — Live action bars (BIG BET + BIG WIN)
Auto-posted styled cards — the live tape that makes the room feel busy. Card anatomy (per
collectoroll): full-width rounded card, **colored left border + soft glow**, an icon/thumbnail tile, a
small label, the handle, a **big colored amount**, and a secondary stat.

- **BIG BET (our gold/yellow `--gold`):** on OPEN with notional ≥ `CHAT_BIG_BET_USD` (admin, default
  $500) → card-art tile · `BIG BET` label · `{handle} opened {LONG/SHORT} {lev}x` · big gold
  `${notional}` · market name.
- **BIG WIN (green `--success`):** on close with realized profit ≥ `CHAT_BIG_WIN_USD` (admin, default
  $100) → trophy tile · `BIG WIN` label · `{handle} closed {market}` · big green `+${profit}` · secondary
  `+{roe}% ROE` (`roe = realizedPnl / margin × 100`).
- **Emission:** `engine.openPosition` (post-fill) and `closePosition` (post-realize) call a new
  `chatEvent(db, {...})` that persists a `kind='event'` row and `publish('chat','event',payload)`.
  Wrapped/non-fatal — a chat hiccup can never affect a trade.
- **Identity:** the trader's chat handle (username, else truncated pubkey). Auto-on for all (per-user
  opt-out can come later). Thresholds are admin knobs (see CHAT admin view).

## F2 — Emoji reactions
- `chat_reactions(message_id, user_id, emoji)` (PK all three). Hover a message → quick set
  (👍🔥😂💀🚀) + optional full picker.
- Live via `publish('chat','reaction',{messageId, emoji, userId, op:'add'|'remove'})`; aggregated counts
  under the message, viewer's own highlighted. `POST/DELETE /chat/:id/react {emoji}` (auth).

## F3 — Profile hover cards + level
Hover handle/avatar → card: **handle · level · rank badge · MOD tag**. P/L and volume are computed but
**hidden in the UI for now** (flag-gated, trivial to flip on).

**Rank vs level (answering "do we just use the leaderboard?"):** they're complementary —
- **Rank** = your position on the PnL **leaderboard** (competitive, scarce, can drop) → drives the
  *badge* (F4). Most users are unranked → no badge.
- **Level** = a progression tier that **only goes up**, so *everyone* has a positive identity marker
  (the casino pattern). Best derived from **cumulative traded volume** (Σ notional from `fills`), NOT
  leaderboard PnL — a PnL-based "level" would punish losing traders and swing around. Tiers: L1 <$1k,
  L2 $1k, L3 $10k, L4 $50k, L5 $250k, L6 $1M+. Pure fn `userLevel(volumeUsd)`.
- So: **leaderboard → rank badge; volume → level.** Both cheap, both in the author map.

`GET /chat/profile/:userId` → `{handle, level, rank, badges, isMod, plE6, volumeE6}` (UI shows
handle/level/badge/MOD; hides pl/volume for now).

## F4 — Rank badges (from the leaderboard) — APPROVED
`leaderboard.ts` ranks users by realized PnL. A **periodically-refreshed (~60s) in-memory
`userId → {rank, level, isMod}` map** (the live-fee-knob pattern; O(1) per render). **Badge tiers:**
👑 `#1`, 🥈 `#2`, 🥉 `#3`, then `TOP 10` / `TOP 100` chips — scarce/aspirational, next to the handle in
chat + on the hover card. Attached to outgoing `message`/`event` payloads + the profile endpoint.

## F5 — Moderation
Prereq for any DROP/rain (giveaways attract bots — every casino gates + moderates).
- **Schema:** `users.is_mod`, `users.chat_muted_until`, `users.chat_banned`.
- **Operator grants mods** (ADMIN_API_KEY) from the CHAT admin view → a teal **MOD** chip next to mod
  handles in chat + hover (per collectoroll).
- **Mod actions** (logged-in `is_mod`, via a new `requireMod` guard, distinct from the operator key):
  `DELETE /chat/:id` (soft-delete `deleted_at/by`, broadcast `type:'delete'`), `POST /chat/mute
  {userId,minutes}`, `POST /chat/ban {userId}` (+ unban). `postChat`/react reject banned/muted users.
  The operator key can do everything a mod can.

## F6 — DROP (timed giveaway)
flip.gg-style "rain", our brand: **DROP**. A slim bar pinned at the **top of the chat** — *"It's about
to DROP"* (big styled word, our accent) + a **pot pill** (mascot + amount) + a **countdown** — opening a
modal. Style per `references/flipgg-rain-bar.png`, in OUR palette (dark + `--accent`/`--gold`).

**Money model (decided): real money, house-funded baseline + player top-up.** The app runs on **real
funds** today, so DROP is a real-USDC feature end to end — no play-money path. The **house funds and buys
the pack**; **player tips (real USDC) top up the pot** to cut the house's cost or, when tips are large
enough, to **buy a bigger pack** (pack tier scales with the pot: e.g. $250 → $500 → $1,000). Tips are not
required for a round to run — they only raise the ceiling.

**Phase 1 (build now): teaser.**
- The DROP bar (countdown + pot, our styling) at the top of the chat.
- Click → modal that explains the mechanic + **"Coming soon!"**; tip input present but disabled. Copy:
  *"Every DROP, the house opens a **TCG pack** (bigger when the pot grows) — cards up to **$20,000 USDC**.
  One eligible wallet wins the card drawn. Eligible = you've deposited (or hold 500K+ $GDEX). Add to the
  pot:"*

**Phase 2 (full mechanic, later):**
- **Cadence:** admin knob `DROP_INTERVAL` (every N min / hour / day).
- **Pot bucket = `DROP_POOL` ledger system account** (double-entry, via `getOrCreateSystemAccount`). Funded
  two ways, both **real USDC**: (1) the **house contribution** each round (TREASURY/house → `DROP_POOL`,
  an admin knob `DROP_HOUSE_FLOOR`), and (2) **player tips** (user active balance → `DROP_POOL`, validated
  against `availableUusdc`). The admin CHAT view shows the live bucket balance.
- **Pack tier from the pot:** at round close, pick the **largest pack tier the pot can afford** (tiers are
  an admin-config list, e.g. `[250, 500, 1000]`). Any pot remainder **rolls into the next round** (never
  lost). If the pot can't cover even the floor tier (shouldn't happen given the house floor), the round
  **defers and tips roll over** — no round runs with an unfunded pack.
- **Round close (worker loop, single-leader via a lease):** resolve the pack tier → buy + open the pack
  **via the rare.win API** (new provider client). Buying a pack is a **real-money outflow** (real USDC
  leaves custody to rare.win): debit `DROP_POOL`, record it on the **custody outflow path** (treated like a
  withdrawal for PoR/treasury reconciliation, NOT a silent ledger burn) → draw a card → draw a **random
  eligible wallet** (record the RNG seed on the round for auditability) → record winner → award the card.
- **Prize delivery (decided): on-chain NFT, winner chooses at claim.** The drawn card is an **NFT**. On
  win it's attributed to the winner's **GachaDex platform wallet** (custodial, like USDC custody). At claim
  the winner picks one of two:
  - **Sell back instantly → USDC** credited to their platform active balance. Buyback price = the card's
    **current market value** via the existing card pricing (`priceCard`/oracle), with an optional house
    spread/haircut knob (`DROP_BUYBACK_SPREAD`). The house then holds the NFT (can relist). *Open:* a card
    not in a tracked market needs a price source; buyback is a real-USDC outflow the house must fund.
  - **Keep the NFT** — it stays in the platform wallet, recorded in `nft_holdings` (status `held`).
  - **Phase 2 (later): withdraw the NFT to an external wallet** — mirrors USDC withdrawal exactly (custody
    outflow, step-up signature, in-flight recovery). Until that ships, NFTs live in the platform wallet.
- **Eligibility:** wallet has **deposited** (`deposits` table) **OR** holds **≥500,000 $GDEX** — mint
  `3FdoksSvontxzSg42mfBccFp8zmH4KdgbS8bsoMgpump` (Solana SPL; check the connected wallet's token balance
  via the Helius RPC, `getParsedTokenAccountsByOwner` filtered by mint; UI amount ≥ 500,000 — *verify the
  mint's decimals*). Both arms buildable now (deposits = a query; GDEX = an on-chain read we already have
  RPC for).
- **Draw animation:** slot / wheel / rotating row with a highlighted arrow bar, driven over WS
  (`type:'drop'`: `countdown` ticks → `result`).
- **Schema:** `drop_rounds(id,status,pot_uusdc,scheduled_at,drawn_at,winner_user_id,card_meta)`,
  `drop_tips(round_id,user_id,amount_uusdc)`.
- **Dependency:** rare.win API access + pack-open endpoint (we'll have it for Phase 2).

## F7 — Presence (online count)
Both references show it prominently ("350 online" / "24 ONLINE"). A green-dot **"N online"** in the chat
header. Server tracks live WS connections (TTL-based presence on the `chat` subscription);
`publish('chat','presence',{count})` on change (throttled). Cheap, big "this place is alive" signal.

## F8 — Visual & typography redesign (readability + flow)
The chat must be **easy to read** and feel polished. Work *within* the existing design system (theme
fonts in `themes.css`; no generic Inter/Roboto).
- **Legibility:** message bodies + handles use the skin's **body font** (already defined for non-arcade
  skins); for the arcade/pixel skin, render chat *text* in a readable companion font (keep Press Start
  2P for the brand/headers only — pixel fonts are unreadable at chat density). Bump line-height (~1.4),
  comfortable font-size, sensible letter-spacing.
- **Message grouping:** consecutive messages from the same author within ~5 min group under one
  avatar/handle (Discord/collectoroll style) — less repetition, cleaner scan.
- **Hierarchy & spacing:** bold colored handle, muted right-aligned timestamp, high-contrast body;
  comfortable vertical rhythm; subtle hover highlight per row; refined rounded message treatment.
- **Header:** `● LIVE CHAT` + the **online count** + collapse; the **DROP bar pinned** directly under it.
- **Action bars:** full-width rounded cards with colored border+glow (green win / gold bet) + icon-tile +
  big amount, per F1.
- **Input row:** cleaner field, emoji button, accent send button; reply banner above it.
- **Scroll:** smooth; a **"new messages ↓" pill** when scrolled up; auto-stick at bottom.
- **Avatars:** keep color-initial; add a subtle ring for mods / top-rank.
- Audit contrast on the dark background; tune muted vs primary text tokens.

---

## Data model (additions)
```sql
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'message'; -- message|event
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS meta JSONB;            -- event card payload
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS deleted_by TEXT;
ALTER TABLE chat_messages ALTER COLUMN user_id DROP NOT NULL; -- system/DROP event rows have no trader
-- listChat must filter `WHERE deleted_at IS NULL`.

CREATE TABLE IF NOT EXISTS chat_reactions (
  message_id TEXT NOT NULL REFERENCES chat_messages(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  emoji      TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji)
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_mod BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS chat_muted_until TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS chat_banned BOOLEAN NOT NULL DEFAULT false;

-- Phase 2 (DROP). DROP_POOL is a ledger system account (getOrCreateSystemAccount), not a table.
CREATE TABLE IF NOT EXISTS drop_rounds (
  id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'open',
  pot_uusdc BIGINT NOT NULL DEFAULT 0, scheduled_at TIMESTAMPTZ NOT NULL,
  drawn_at TIMESTAMPTZ, winner_user_id TEXT REFERENCES users(id), card_meta JSONB,
  pack_usd INT,                 -- pack tier actually opened (chosen from the pot)
  house_uusdc BIGINT NOT NULL DEFAULT 0,  -- house contribution this round
  rng_seed TEXT,                -- recorded for draw auditability
  prize_mint TEXT,              -- the won card's NFT mint
  payout_kind TEXT, payout_uusdc BIGINT   -- 'sellback' (USDC credited) | 'nft' (kept); buyback amount if sold
);
CREATE TABLE IF NOT EXISTS drop_tips (
  id BIGSERIAL PRIMARY KEY, round_id TEXT NOT NULL REFERENCES drop_rounds(id),
  user_id TEXT NOT NULL REFERENCES users(id), amount_uusdc BIGINT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- NFTs custodied in the platform wallet per user (kept prizes; Phase 2 adds on-chain transfer-out).
CREATE TABLE IF NOT EXISTS nft_holdings (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  mint TEXT NOT NULL, card_meta JSONB, source_round_id TEXT REFERENCES drop_rounds(id),
  status TEXT NOT NULL DEFAULT 'held',   -- held | sold_back | withdrawn
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## Admin — new "CHAT" view (3rd tab, alongside Main + Customers)
All chat/social ops live here, separate from trading admin.

**Integration (match the existing panel exactly):** `AdminPanel.jsx` holds `tab` state (`'main' |
'customers'`) and renders `admin-tab` buttons; `CustomersView` is a sibling component shown on its tab,
taking `adminKey` (+ `onGoToMarket`). So:
- Add a third `<button className="admin-tab">Chat</button>` → `tab === 'chat'`.
- New **`ChatAdminView`** component (mirror `CustomersView`): fetch-on-mount + poll using `adminKey`,
  reuse the `Stat`/`PnlStat`/`admin-tabs`/table styles already in the panel.
- All backend routes live in `admin-ops.ts` under the existing `requireAdminKey` hook (registers whenever
  `ADMIN_API_KEY` is set — both fund modes — like the fee/customers routes). `api.js` gets matching
  `adminKey`-passing methods, same shape as `adminGetFee`/`adminSetFee`.

**Panel 1 — Thresholds** (live `settings` knobs; the `feeView`/`setFee` + boot-load + 30s-refresh pattern)
- `CHAT_BIG_BET_USD` (500), `CHAT_BIG_WIN_USD` (100) — numeric inputs (USD), each with a save button.
- Routes: `GET /admin/chat/thresholds` → values + defaults; `POST /admin/chat/thresholds`.
- Loader: add to the boot `loadFees`-style group so all instances converge + pick up edits within ~30s.

**Panel 2 — DROP config + bucket**
- Knobs (settings): `DROP_INTERVAL`, `DROP_HOUSE_FLOOR`, `DROP_PACK_TIERS` (list editor, e.g.
  `[250,500,1000]`), `DROP_BUYBACK_SPREAD`, eligibility (`GDEX_MIN` 500K + the mint shown read-only).
- Read-only displays: **`DROP_POOL` bucket balance** (a `Stat`, read from the system account) and a
  **recent-rounds table** from `drop_rounds` (pot, pack tier opened, winner, sell-back vs kept, payout).
- Routes: `GET/POST /admin/chat/drop-config`; `GET /admin/chat/drop` → `{ bucketE6, recentRounds }`.
- **Phasing:** Phase 1 ships only the knobs + bucket `Stat`; the rounds table + buyback knob are Phase 2.

**Panel 3 — Moderation**
- Grant/revoke **MOD** per user (user search/select → toggle `users.is_mod`).
- Lists of currently **muted** / **banned** users, each with unmute / unban buttons.
- **Mod-action audit log** view (who deleted/muted/banned what + when — the audit trail from QA item E).
- Routes: `GET /admin/chat/mods` → `{ mods, muted, banned, auditLog }`; `POST /admin/chat/mods/:userId`
  with an action (`grant` | `revoke` | `unmute` | `unban`).

**Out of scope for this view** (customer-facing, specced in F5/F6, not the admin panel): the in-chat mod
controls (delete/mute/ban buttons, MOD tag) and the DROP bar.

**Unrelated copy fix to fold in:** `AdminPanel.jsx:534` still reads "this deployment is play money" — now
false (real funds); correct it when the panel is next touched.

## WS events (all on `chat`)
`message` · `event` · `reaction` · `delete` · `presence` · `drop`.

## Build order
1. **F1 action bars** (+ the F8 card styling) — most on-brand, reuses engine + chat WS.
2. **F5 moderation** — safety floor.
3. **F2 reactions + F3 hover/level + F4 rank badges + F7 presence** — identity/polish.
4. **F8 typography/readability pass** — can fold into each step or do as one polish sweep.
5. **F6 Phase 1** — DROP bar + coming-soon modal + the CHAT admin view skeleton.
6. **F6 Phase 2** — full DROP (rare.win + DROP_POOL + GDEX/deposit eligibility + draw animation).

## Resolved decisions
- Rank = leaderboard badge (medals + TOP10/100); level = cumulative-volume tier. ✓
- GDEX eligibility via mint `3FdoksSvontxzSg42mfBccFp8zmH4KdgbS8bsoMgpump`, ≥500K, on-chain check. ✓
- DROP pot = **house floor + real-USDC tips** → `DROP_POOL` ledger bucket → funds packs (tier scales with
  the pot); buying a pack is a real-money custody outflow; shown in admin. ✓
- Thresholds + DROP config as admin knobs in a dedicated **CHAT** admin view. ✓
- Action bars persist in history; win=green, bet=gold; identity=chat handle. ✓

## QA review — gaps found & resolutions
Adversarial pass against the codebase. All resolved in-spec except **D** (needs a product call).

- **A. `chat_messages.user_id` is `NOT NULL`** → can't insert system/DROP announcement rows. *Fix:* drop
  the NOT NULL (above); BIG BET/WIN keep the trader's id, system/DROP rows use null + `kind`/`meta`.
- **B. ROE needs margin, which `closePosition` doesn't return** (`{orderId, realizedPnlUusdc, closedQty,
  remainingQty}` only). *Fix:* emit `chatEvent` **inside** the engine fns where `pos.margin_uusdc` +
  `closeQty` are known; ROE = `realizedPnl / (margin × closeFraction)` (correct for partial closes).
  Capture the payload in-tx, but `publish`/persist **after commit** so chat can't roll back a trade.
  BIG BET fires on **open _and_ increase** when the added notional ≥ threshold.
- **C. `getLeaderboard` returns only top-N + viewer**, but rank badges need *every* author's rank. *Fix:*
  the full `ranked` array already exists internally — expose a `rankMap(db) → userId→{rank,total,volume}`
  for the 60s author-map refresh. (Volume there also feeds the level.)
- **D. DROP money model — RESOLVED (real money, house-funded + player top-up).** The app runs on real
  funds, so DROP is real USDC end to end. The **house funds/buys the pack**; **player tips (real USDC) top
  up the pot** to cut house cost or unlock a **bigger pack** (tier scales with the pot, e.g. $250 → $500 →
  $1,000). `DROP_POOL` holds real USDC; buying a pack is a **real-money custody outflow** to rare.win
  (record on the withdrawal/PoR path, not a silent ledger burn); pot remainder **rolls to the next round**.
  See F6. **Prize delivery resolved:** the card is an **on-chain NFT** → winner either **sells back
  instantly for USDC** (market value via `priceCard`, optional house spread) or **keeps the NFT** in their
  platform wallet (`nft_holdings`); **Phase 2** adds on-chain **NFT withdrawal** mirroring USDC withdrawal.
  **Compliance:** DROP sits behind the mainnet real-funds gate (`ALLOW_MAINNET_FUNDS` — audit + KYC/AML +
  geofence, per `config.ts`); the operator has **switched all gates open for real-money testing** now, with
  the gated posture restored for production.
- **E. Moderation hardening:** `listChat` filters deleted; add a **mod-action audit** (who deleted/muted/
  banned what + when, like `market_restriction_events`); operator (admin-key, CHAT view) and mod
  (user-auth, in-chat) are two paths to the same actions; ban-evasion via a new wallet is inherent to
  wallet identity (no IP/device tracking) — accepted limitation.
- **F. Presence multi-instance:** "online" = active WS connections incl. anonymous viewers; across
  multiple API instances the count must aggregate (heartbeat row) or we ship a per-instance approximation
  first and note it.
- **G. Arcade-skin chat font:** don't introduce a generic font — pick an already-loaded, characterful but
  legible face for chat *text* (keep Press Start 2P for brand/headers only).
- **H. Cross-cutting:** hover cards need a **tap** variant on touch/mobile; rate-limit reactions + tips;
  when an author isn't in the map yet, default gracefully (level from volume=0 → L1, no badge); **every
  feature ships with tests + the QA + /simplify cycle** (standing rule).

## Remaining dependencies / decisions
- **rare.win API** — access + pack-open endpoint, AND confirm the pack output is an **on-chain NFT** we can
  custody in the platform wallet (the whole prize model assumes this). DROP Phase 2.
- **Sell-back pricing + funding** — buyback uses `priceCard` market value (+ optional `DROP_BUYBACK_SPREAD`);
  needs a price source for a card not in a tracked market, and the house must fund the USDC buyback outflow.
  DROP Phase 2.
- **Compliance** — gated posture (`ALLOW_MAINNET_FUNDS`: audit + KYC/AML + geofence) for production; gates
  currently switched open for real-money testing. Confirmed, no further decision needed.
