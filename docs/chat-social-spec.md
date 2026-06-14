# Chat & social layer — spec

Turning the left-rail chat from a plain message list into the platform's social/engagement engine:
live action bars, reactions, identity/rank, moderation, and the **DROP** giveaway. Blends crypto-casino
chat energy (Stake/flip.gg) with perp-DEX flexing (Hyperliquid).

## Current baseline
Global live chat (`ChatSidebar.jsx` + `store/chat.js`, server `services/chat.ts`): messages with
color-initial avatars, @mentions, reply/quote, username editing, unread badge, 280-char cap,
rate-limited posting. Realtime via the WS `chat` channel (`publish('chat','message',msg)` → client
subscribes `['chat']`). Reused throughout this spec.

## Architecture notes (reuse what exists)
- **Transport:** everything rides the existing `chat` WS channel with new `type`s: `message` (today),
  `event` (action bars), `reaction`, `delete`, `drop` (countdown/result). No new socket plumbing.
- **History:** action bars persist as `chat_messages` rows with `kind='event'` + a `meta` JSONB, so a
  user scrolling up still sees recent big wins (and reactions can apply to them).
- **Author metadata** (level, rank badge, MOD tag) is attached to outgoing chat payloads + the profile
  endpoint from a periodically-refreshed in-memory map (see F4), so we never recompute per message.

---

## F1 — Live action bars (big bet + profit close)

Auto-posted, styled "event" messages — the live tape that makes the room feel busy (à la collectoroll).

- **Big bet (gold bar):** on position OPEN with notional ≥ `CHAT_BIG_BET_USD` (admin knob, default
  $500) → `{handle} opened {LONG/SHORT} {lev}x · ${notional} · {market}` with the card thumb.
- **Profit close (green bar):** on close with realized profit ≥ `CHAT_BIG_WIN_USD` (default $100) →
  `{handle} closed {market} +${profit} ({+roe}% ROE)`. `roe = realizedPnl / margin × 100`.
- **Emission:** `engine.openPosition` (after fill) and `closePosition` (after realize) call a new
  `chatEvent(db, {...})` that persists a `kind='event'` row and `publish('chat','event',payload)`.
  Non-fatal (wrapped) — a chat hiccup must never affect a trade.
- **Identity:** the trader's chat handle (username, else truncated pubkey). Auto-on for all; a per-user
  opt-out can come later.
- **Thresholds** are `settings` knobs loaded like the fee knob (boot + 30s refresh), tunable in admin.

## F2 — Emoji reactions
- New `chat_reactions(message_id, user_id, emoji)` (PK all three → one of each emoji per user per msg).
- Hover a message → reaction button → curated quick set (👍🔥😂💀🚀) + optional full picker.
- Live via `publish('chat','reaction',{messageId, emoji, userId, op:'add'|'remove'})`; client renders
  aggregated counts under the message, highlighting the viewer's own.
- Endpoints: `POST /chat/:id/react {emoji}`, `DELETE /chat/:id/react {emoji}` (auth required).

## F3 — Profile hover cards + levels
- Hover handle/avatar → card: **handle, level, rank badge, MOD tag**. P/L and volume are computed
  server-side but **hidden in the UI for now** (behind a flag, trivial to enable later).
- **Levels (new):** no level concept exists today. Proposed: derive from **cumulative traded volume**
  (Σ notional from `fills` per user) into tiers — e.g. L1 <$1k, L2 $1k, L3 $10k, L4 $50k, L5 $250k,
  L6 $1M+. Pure function `userLevel(volumeUsd)`; volume cached in the author map (F4). *Decision needed:
  basis = volume vs deposits vs activity-XP.*
- Data: `GET /chat/profile/:userId` → `{handle, level, rank, badges, isMod, plE6, volumeE6}` (UI shows
  handle/level/badge/MOD; hides pl/volume for now).

## F4 — Rank badges (from the leaderboard)
`leaderboard.ts` already ranks users by realized PnL. Proposed approach:
- A periodically-refreshed (~60s) in-memory **`userId → {rank, level, isMod}` map** (same pattern as the
  live fee knob). Recomputing per message would be wasteful; this is O(1) per render.
- **Badge tiers** (scarce/aspirational): 👑 `#1`, 🥈 `#2`, 🥉 `#3`, then `TOP 10` / `TOP 100` chips.
  Shown next to the handle in chat + on the hover card. Unranked users show no badge.
- The map is attached to outgoing chat `message`/`event` payloads (author badge travels with the msg) and
  served by the profile endpoint.

## F5 — Moderation
Prereq for any rain/DROP (giveaways attract bots/farmers — every casino gates + moderates).
- **Schema:** `users.is_mod BOOLEAN`, `users.chat_muted_until TIMESTAMPTZ`, `users.chat_banned BOOLEAN`.
- **Operator grants mods** (ADMIN_API_KEY): `POST /admin/chat/mods {userId, isMod}` + a "Make mod"
  toggle in the admin Customers view. A **MOD** chip renders next to mod handles in chat + hover.
- **Mod actions** (logged-in user with `is_mod`, via a new `requireMod` guard — distinct from the
  operator key):
  - `DELETE /chat/:id` → soft-delete (`deleted_at`,`deleted_by`); broadcast `type:'delete'` so clients
    remove it live.
  - `POST /chat/mute {userId, minutes}` → set `chat_muted_until`.
  - `POST /chat/ban {userId}` / unban → set `chat_banned`.
- **Enforcement:** `postChat` rejects banned/muted users (and reactions). The operator key can do
  everything a mod can.

## F6 — DROP (timed giveaway)

flip.gg-style "rain", our brand: **DROP**. A slim bar pinned at the **top of the chat** — *"It's about
to DROP"* + a live countdown + current pot — that opens a modal.

**Phase 1 (build now): teaser only.**
- DROP bar (countdown + pot, our styling) at the top of the chat rail.
- Click → modal that **explains the mechanic** and shows **"Coming soon!"**; the tip input is present but
  disabled. Copy: *"Every DROP, a **$250 TCG pack** is opened — cards up to **$20,000 USDC**. One
  eligible wallet wins the card drawn. Eligible = you've deposited into the platform (or hold 500K+
  $GDEX). Add to the pot:"*

**Phase 2 (full mechanic, later):**
- **Cadence:** admin knob `DROP_INTERVAL` (every N min / hour / day) via `settings`.
- **Round close (worker loop, single-leader via a lease):** buy + open a **$250 pack via the rare.win
  API** (new provider client) → draw a card → draw a **random eligible wallet** → record winner → award
  the card.
- **Eligibility pool:** wallets that have **deposited** (`deposits` table) **OR** hold **≥500K $GDEX**.
  *Note: `$GDEX` is not in the system yet → that arm is future (on-chain balance check); ship Phase 2
  with the deposit arm first.*
- **Pot / tipping:** users add play-money tips to the pot. *Decision needed: what the pot does —
  fund/grow the pack, a separate cash prize, or boost the tipper's odds.*
- **Draw animation:** slot / wheel / rotating row with a highlighted arrow bar, driven by the round
  result over WS (`type:'drop'`: `countdown` ticks, then `result`).
- **Schema:** `drop_rounds(id, status, pot_uusdc, scheduled_at, drawn_at, winner_user_id, card_meta)`,
  `drop_tips(round_id, user_id, amount_uusdc)`.
- **Dependencies:** rare.win API access + pack-open endpoint; the $GDEX token; the pot decision.

---

## Data model (all additions)
```sql
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'message'; -- message|event
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS meta JSONB;            -- event card payload
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS deleted_by TEXT;

CREATE TABLE IF NOT EXISTS chat_reactions (
  message_id TEXT NOT NULL REFERENCES chat_messages(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  emoji      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji)
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_mod BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS chat_muted_until TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS chat_banned BOOLEAN NOT NULL DEFAULT false;

-- Phase 2 (DROP):
CREATE TABLE IF NOT EXISTS drop_rounds (
  id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'open',
  pot_uusdc BIGINT NOT NULL DEFAULT 0, scheduled_at TIMESTAMPTZ NOT NULL,
  drawn_at TIMESTAMPTZ, winner_user_id TEXT REFERENCES users(id), card_meta JSONB
);
CREATE TABLE IF NOT EXISTS drop_tips (
  id BIGSERIAL PRIMARY KEY, round_id TEXT NOT NULL REFERENCES drop_rounds(id),
  user_id TEXT NOT NULL REFERENCES users(id), amount_uusdc BIGINT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## WS events (all on the `chat` channel)
`message` (today) · `event` (action bar) · `reaction` · `delete` · `drop` (countdown + result).

## Admin / config knobs (`settings`, live-loaded like the fee knob)
`CHAT_BIG_BET_USD` (500) · `CHAT_BIG_WIN_USD` (100) · `DROP_INTERVAL` · `DROP_PACK_USD` (250) ·
mod grants · (DROP eligibility params).

## Build order
1. **F1 action bars** — most on-brand impact, reuses engine + chat WS, no new economy/moderation.
2. **F5 moderation** — safety floor before any social scale or rain.
3. **F2 reactions + F3 hover cards + F4 rank badges** — chat polish/identity.
4. **F6 Phase 1** — DROP bar + coming-soon modal (marketing teaser).
5. **F6 Phase 2** — full DROP (needs rare.win + $GDEX + pot decision).

## Open questions / decisions
1. **Level basis** — cumulative volume (proposed) vs deposits vs activity-XP?
2. **DROP pot role** — what do tips into the pot do (fund pack / separate prize / odds boost)?
3. **rare.win API** — do we have access + the pack-open endpoint?
4. **$GDEX eligibility** — token not in-system yet; ship DROP with the deposit arm only first?
5. **Action-bar identity** — show chat handle (truncated pubkey if no username); auto-on for all OK?
6. **Rank badge style** — medals(top-3) + TOP10/100 chips (proposed) vs numeric rank?
7. **Persist action bars in history** (proposed) vs ephemeral?
