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

**Phase 1 (build now): teaser.**
- The DROP bar (countdown + pot, our styling) at the top of the chat.
- Click → modal that explains the mechanic + **"Coming soon!"**; tip input present but disabled. Copy:
  *"Every DROP, a **$250 TCG pack** is opened — cards up to **$20,000 USDC**. One eligible wallet wins the
  card drawn. Eligible = you've deposited (or hold 500K+ $GDEX). Add to the pot:"*

**Phase 2 (full mechanic, later):**
- **Cadence:** admin knob `DROP_INTERVAL` (every N min / hour / day).
- **Pot bucket:** tips move **from the user's active balance → a new `DROP_POOL` ledger system account**
  (double-entry, like the other system accounts). The **DROP bucket balance funds the pack purchases**;
  the admin CHAT view shows the current bucket balance.
- **Round close (worker loop, single-leader via a lease):** buy + open a **$250 pack via the rare.win
  API** (new provider client) funded from `DROP_POOL` → draw a card → draw a **random eligible wallet** →
  record winner → award the card.
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
  drawn_at TIMESTAMPTZ, winner_user_id TEXT REFERENCES users(id), card_meta JSONB
);
CREATE TABLE IF NOT EXISTS drop_tips (
  id BIGSERIAL PRIMARY KEY, round_id TEXT NOT NULL REFERENCES drop_rounds(id),
  user_id TEXT NOT NULL REFERENCES users(id), amount_uusdc BIGINT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## Admin — new "CHAT" view (3rd tab, alongside Main + Customers)
All chat/social ops live here, separate from trading admin:
- **Thresholds:** `CHAT_BIG_BET_USD` (500), `CHAT_BIG_WIN_USD` (100) — live `settings` knobs.
- **DROP config:** `DROP_INTERVAL`, `DROP_PACK_USD` (250); **DROP bucket balance** (the `DROP_POOL`
  account) displayed; eligibility params.
- **Moderation:** grant/revoke MOD per user; view muted/banned; (deletes/mutes happen in-chat by mods).

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
- DROP pot = tips from active balance → `DROP_POOL` ledger bucket → funds packs; shown in admin. ✓
- Thresholds + DROP config as admin knobs in a dedicated **CHAT** admin view. ✓
- Action bars persist in history; win=green, bet=gold; identity=chat handle. ✓

## Remaining dependency
- **rare.win API** access + pack-open endpoint — needed only for DROP **Phase 2**.
