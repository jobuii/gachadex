import { randomUUID } from 'node:crypto';
import { formatUsd } from '@pokex/pricing';
import { HttpError } from '../errors.ts';
import type { Db } from '../db/client.ts';
import { publish } from './bus.ts';
import { handleFor } from './handles.ts';
import { userStanding } from './leaderboard.ts';

const MAX_BODY = 280;

export interface ReplyContext {
  id: string;
  handle: string;
  body: string;
}
export interface ChatMessage {
  id: string;
  userId: string;
  handle: string;
  avatar: string | null; // profile sprite path under /avatars/ (null → client derives one from userId)
  body: string;
  createdAt: string;
  replyTo: ReplyContext | null;
  kind: string; // 'message' | 'event'
  meta: Record<string, unknown> | null; // structured payload for 'event' rows; null for plain messages
  isMod: boolean; // author is a moderator (drives the MOD chip)
  authorMutedUntil?: string | null; // author's current mute expiry — lets a mod see mute↔unmute state
  authorBanned?: boolean; // author currently banned — lets a mod see ban↔unban state
  reactions?: Record<string, number>; // emoji -> count
  myReactions?: string[]; // emojis the viewer has reacted with (empty when anonymous)
}

/** Recent messages, oldest-first, each with reply context + reaction counts (and the viewer's own). */
export async function listChat(db: Db, opts: { limit?: number; viewerUserId?: string } = {}): Promise<ChatMessage[]> {
  const n = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const r = await db.query<{
    id: string; user_id: string; body: string; created_at: string; dn: string | null; pk: string; av: string | null; author_mod: boolean;
    author_mu: string | null; author_banned: boolean;
    kind: string; meta: Record<string, unknown> | null;
    reply_to: string | null; p_body: string | null; p_dn: string | null; p_pk: string | null;
  }>(
    `SELECT c.id, c.user_id, c.body, c.created_at, c.kind, c.meta, u.display_name AS dn, u.solana_pubkey AS pk, u.avatar AS av,
            u.is_mod AS author_mod, u.chat_muted_until AS author_mu, u.chat_banned AS author_banned,
            c.reply_to, p.body AS p_body, pu.display_name AS p_dn, pu.solana_pubkey AS p_pk
     FROM chat_messages c
     JOIN users u ON u.id = c.user_id
     LEFT JOIN chat_messages p ON p.id = c.reply_to AND p.deleted_at IS NULL
     LEFT JOIN users pu ON pu.id = p.user_id
     WHERE c.deleted_at IS NULL
     ORDER BY c.created_at DESC, c.id DESC LIMIT $1`,
    [n],
  );

  // reaction counts (+ which the viewer reacted with) for just the fetched messages, in one query
  const ids = r.rows.map((m) => m.id);
  const byMsg = new Map<string, { reactions: Record<string, number>; mine: string[] }>();
  if (ids.length) {
    const rx = await db.query<{ message_id: string; emoji: string; n: number; mine: boolean | null }>(
      `SELECT message_id, emoji, COUNT(*)::int AS n, BOOL_OR(user_id = $2) AS mine
       FROM chat_reactions WHERE message_id = ANY($1) GROUP BY message_id, emoji`,
      [ids, opts.viewerUserId ?? null],
    );
    for (const x of rx.rows) {
      let e = byMsg.get(x.message_id);
      if (!e) { e = { reactions: {}, mine: [] }; byMsg.set(x.message_id, e); }
      e.reactions[x.emoji] = x.n;
      if (x.mine) e.mine.push(x.emoji);
    }
  }

  return r.rows.reverse().map((m) => ({
    id: m.id,
    userId: m.user_id,
    handle: handleFor(m.dn, m.pk),
    avatar: m.av,
    body: m.body,
    createdAt: m.created_at,
    // a soft-deleted parent is excluded by the join (p_pk null) -> drop the quote rather than leak its body
    replyTo: m.reply_to && m.p_pk ? { id: m.reply_to, handle: handleFor(m.p_dn, m.p_pk), body: m.p_body ?? '' } : null,
    kind: m.kind,
    meta: m.meta,
    isMod: m.author_mod,
    authorMutedUntil: m.author_mu,
    authorBanned: m.author_banned,
    reactions: byMsg.get(m.id)?.reactions ?? {},
    myReactions: byMsg.get(m.id)?.mine ?? [],
  }));
}

/** Post a message (optionally a reply); persists it and broadcasts on the public `chat` channel. */
export async function postChat(db: Db, userId: string, rawBody: string, replyToId?: string | null): Promise<ChatMessage> {
  const body = rawBody.trim();
  if (!body) throw new HttpError(400, 'message is empty');
  if (body.length > MAX_BODY) throw new HttpError(400, `message too long (max ${MAX_BODY} characters)`);

  // moderation gate: banned users can never post; muted users can't post until the mute expires.
  const gate = await db.query<{ banned: boolean; muted: string | null }>(
    `SELECT chat_banned AS banned, chat_muted_until AS muted FROM users WHERE id = $1`,
    [userId],
  );
  if (gate.rows[0]?.banned) throw new HttpError(403, 'you are banned from chat');
  if (gate.rows[0]?.muted && new Date(gate.rows[0].muted) > new Date()) throw new HttpError(403, 'you are muted');

  let replyTo: ReplyContext | null = null;
  if (replyToId) {
    const p = await db.query<{ id: string; body: string; dn: string | null; pk: string }>(
      `SELECT c.id, c.body, u.display_name AS dn, u.solana_pubkey AS pk
       FROM chat_messages c JOIN users u ON u.id = c.user_id WHERE c.id = $1 AND c.deleted_at IS NULL`,
      [replyToId],
    );
    if (!p.rows[0]) throw new HttpError(400, 'the message you are replying to no longer exists');
    replyTo = { id: p.rows[0].id, handle: handleFor(p.rows[0].dn, p.rows[0].pk), body: p.rows[0].body };
  }

  const id = randomUUID();
  let ins;
  try {
    // Insert and fetch the poster's display name/pubkey in one round-trip (RETURNING joined to users).
    ins = await db.query<{ created_at: string; dn: string | null; pk: string; av: string | null; is_mod: boolean }>(
      `WITH new_msg AS (
         INSERT INTO chat_messages(id, user_id, body, reply_to) VALUES($1, $2, $3, $4)
         RETURNING created_at, user_id
       )
       SELECT m.created_at, u.display_name AS dn, u.solana_pubkey AS pk, u.avatar AS av, u.is_mod
       FROM new_msg m JOIN users u ON u.id = m.user_id`,
      [id, userId, body, replyToId ?? null],
    );
  } catch (e) {
    // parent vanished between the check and the insert -> clean 400, not a 500 (defensive: no delete path today)
    if ((e as { code?: string })?.code === '23503') throw new HttpError(400, 'the message you are replying to no longer exists');
    throw e;
  }

  const msg: ChatMessage = {
    id,
    userId,
    handle: handleFor(ins.rows[0].dn, ins.rows[0].pk),
    avatar: ins.rows[0].av,
    body,
    createdAt: ins.rows[0].created_at,
    replyTo,
    kind: 'message',
    meta: null,
    isMod: ins.rows[0].is_mod,
  };
  publish('chat', 'message', msg);
  return msg;
}

export type ChatEventVariant = 'big_bet' | 'big_win';
export interface ChatEventInput {
  userId: string;
  marketId: string;
  variant: ChatEventVariant;
  side: 'long' | 'short';
  notionalE6: bigint; // size placed (big_bet) / closed-leg notional (big_win)
  pnlE6?: bigint; // realized profit on the closed leg (big_win only)
  roeBps?: number; // return on the closed leg's margin, bps (big_win only)
}

/** Human-readable fallback text; the client renders the styled bar from `meta`, but a body keeps the row
 *  legible anywhere a plain message would be (search, notifications, a client that doesn't know `event`). */
function eventBody(handle: string, marketName: string, evt: ChatEventInput): string {
  const side = evt.side.toUpperCase();
  if (evt.variant === 'big_win') {
    const roe = evt.roeBps != null ? ` (+${Math.round(evt.roeBps / 100)}%)` : '';
    return `${handle} won ${formatUsd(evt.pnlE6 ?? 0n, { decimals: 0 })}${roe} ${side} on ${marketName}`;
  }
  return `${handle} opened ${formatUsd(evt.notionalE6, { decimals: 0 })} ${side} on ${marketName}`;
}

/**
 * Persist + broadcast a chat action bar (BIG BET on a large open, BIG WIN on a large profitable close).
 * MUST be called AFTER the trade tx commits — a chat failure can never roll back a trade, so callers in
 * the engine swallow its errors. The bar persists (kind='event') so it shows in chat history too.
 */
export async function emitChatEvent(db: Db, evt: ChatEventInput): Promise<void> {
  const r = await db.query<{ dn: string | null; pk: string; av: string | null; mkt: string; is_mod: boolean }>(
    `SELECT u.display_name AS dn, u.solana_pubkey AS pk, u.avatar AS av, u.is_mod, m.display_name AS mkt
     FROM users u JOIN markets m ON m.id = $2 WHERE u.id = $1`,
    [evt.userId, evt.marketId],
  );
  if (!r.rows[0]) return; // user or market vanished between commit and emit — nothing to announce
  const handle = handleFor(r.rows[0].dn, r.rows[0].pk);
  const marketName = r.rows[0].mkt;

  const meta: Record<string, unknown> = {
    variant: evt.variant,
    side: evt.side,
    marketId: evt.marketId,
    marketName,
    notionalE6: evt.notionalE6.toString(),
    ...(evt.pnlE6 != null ? { pnlE6: evt.pnlE6.toString() } : {}),
    ...(evt.roeBps != null ? { roeBps: evt.roeBps } : {}),
  };
  const body = eventBody(handle, marketName, evt);

  const id = randomUUID();
  const ins = await db.query<{ created_at: string }>(
    `INSERT INTO chat_messages(id, user_id, body, kind, meta) VALUES($1, $2, $3, 'event', $4) RETURNING created_at`,
    [id, evt.userId, body, JSON.stringify(meta)],
  );
  publish('chat', 'event', {
    id, userId: evt.userId, handle, avatar: r.rows[0].av, body, createdAt: ins.rows[0].created_at, replyTo: null, kind: 'event', meta, isMod: r.rows[0].is_mod,
  } satisfies ChatMessage);
}

/**
 * Persist + broadcast a Games BIG WIN action bar (a big pack pull / prize). Renders in the same chat
 * ActionBar as trade wins (meta.variant='big_win'); `side` is intentionally absent (no long/short for a
 * game). Best-effort — callers swallow its errors so a chat hiccup can never roll back a play.
 */
export async function emitGameWinEvent(
  db: Db,
  evt: { userId: string; marketId: string; payoutE6: bigint; game: string },
): Promise<void> {
  const r = await db.query<{ dn: string | null; pk: string; av: string | null; is_mod: boolean; mkt: string }>(
    `SELECT u.display_name AS dn, u.solana_pubkey AS pk, u.avatar AS av, u.is_mod, m.display_name AS mkt
     FROM users u JOIN markets m ON m.id = $2 WHERE u.id = $1`,
    [evt.userId, evt.marketId],
  );
  if (!r.rows[0]) return;
  const handle = handleFor(r.rows[0].dn, r.rows[0].pk);
  const marketName = r.rows[0].mkt;
  const meta: Record<string, unknown> = {
    variant: 'big_win',
    game: evt.game,
    marketId: evt.marketId,
    marketName,
    pnlE6: evt.payoutE6.toString(),
    notionalE6: evt.payoutE6.toString(),
  };
  const body = `${handle} pulled ${formatUsd(evt.payoutE6, { decimals: 0 })} — ${marketName} (${evt.game})`;
  const id = randomUUID();
  const ins = await db.query<{ created_at: string }>(
    `INSERT INTO chat_messages(id, user_id, body, kind, meta) VALUES($1, $2, $3, 'event', $4) RETURNING created_at`,
    [id, evt.userId, body, JSON.stringify(meta)],
  );
  publish('chat', 'event', {
    id, userId: evt.userId, handle, avatar: r.rows[0].av, body, createdAt: ins.rows[0].created_at, replyTo: null, kind: 'event', meta, isMod: r.rows[0].is_mod,
  } satisfies ChatMessage);
}

export interface PackPullInput {
  userId: string;
  cardName: string | null;
  rarity: string | null;
  valueE6: bigint; // the pulled card's insured value
  paidE6: bigint; // the pack's list price (CC base) → the "Nx" = value ÷ paid
  machineCode: string;
}

/**
 * Persist + broadcast a Classic Gacha "BIG PACK PULL!" action bar — a gold variant fired when a player pulls
 * a Rare or Epic card. Shows the card, its insured value, the multiple over what the pack cost, and the
 * machine. No market join (a pulled card may not map to a GDEX market). Best-effort — callers swallow its
 * errors so a chat hiccup can never roll back a delivery.
 */
export async function emitPackPullEvent(db: Db, evt: PackPullInput): Promise<void> {
  const r = await db.query<{ dn: string | null; pk: string; av: string | null; is_mod: boolean }>(
    `SELECT u.display_name AS dn, u.solana_pubkey AS pk, u.avatar AS av, u.is_mod FROM users u WHERE u.id = $1`,
    [evt.userId],
  );
  if (!r.rows[0]) return; // user vanished between commit and emit — nothing to announce
  const handle = handleFor(r.rows[0].dn, r.rows[0].pk);
  const card = evt.cardName || 'a card';
  const mult = evt.paidE6 > 0n ? Number(evt.valueE6) / Number(evt.paidE6) : 0; // value ÷ what the pack cost → the "Nx"
  const meta: Record<string, unknown> = {
    variant: 'big_pull',
    cardName: card,
    rarity: evt.rarity,
    valueE6: evt.valueE6.toString(),
    paidE6: evt.paidE6.toString(),
    machineCode: evt.machineCode,
  };
  const body = `${handle} pulled ${card} — ${formatUsd(evt.valueE6)} (${mult.toFixed(1)}x on ${formatUsd(evt.paidE6)})`;
  const id = randomUUID();
  const ins = await db.query<{ created_at: string }>(
    `INSERT INTO chat_messages(id, user_id, body, kind, meta) VALUES($1, $2, $3, 'event', $4) RETURNING created_at`,
    [id, evt.userId, body, JSON.stringify(meta)],
  );
  publish('chat', 'event', {
    id, userId: evt.userId, handle, avatar: r.rows[0].av, body, createdAt: ins.rows[0].created_at, replyTo: null, kind: 'event', meta, isMod: r.rows[0].is_mod,
  } satisfies ChatMessage);
}

export interface Profile {
  userId: string;
  username: string | null; // the chosen display name (null if unset)
  handle: string; // what shows in chat (username or truncated pubkey)
  avatar: string | null; // chosen profile sprite path under /avatars/ (null → client derives one from userId)
  isMod: boolean; // viewer is a moderator (drives whether mod controls render)
  mutedUntil: string | null; // viewer's mute expiry (drives the disabled-input "you're muted" state)
  banned: boolean; // viewer is banned (drives the disabled-input "you're banned" state)
  // Own-account stats for the Portfolio banner strip (own data — safe to expose to oneself). From the
  // cached leaderboard snapshot, so this stays cheap.
  rank: number | null;
  total: number;
  level: number;
  realizedE6: string; // lifetime net realized P/L
  volumeE6: string; // lifetime traded notional
}

export async function getProfile(db: Db, userId: string): Promise<Profile> {
  const r = await db.query<{ dn: string | null; pk: string; av: string | null; is_mod: boolean; mu: string | null; banned: boolean }>(
    `SELECT display_name AS dn, solana_pubkey AS pk, avatar AS av, is_mod, chat_muted_until AS mu, chat_banned AS banned FROM users WHERE id = $1`,
    [userId],
  );
  if (!r.rows[0]) throw new HttpError(404, 'user not found');
  const s = await userStanding(db, userId);
  return {
    userId,
    username: r.rows[0].dn,
    handle: handleFor(r.rows[0].dn, r.rows[0].pk),
    avatar: r.rows[0].av,
    isMod: r.rows[0].is_mod,
    mutedUntil: r.rows[0].mu,
    banned: r.rows[0].banned,
    rank: s.rank,
    total: s.total,
    level: s.level,
    realizedE6: s.pnlUusdc,
    volumeE6: s.volumeUusdc,
  };
}

export interface ProfileCard {
  userId: string;
  handle: string;
  avatar: string | null; // profile sprite path under /avatars/ (null → client derives one from userId)
  isMod: boolean;
  rank: number | null; // leaderboard rank (null if no standing)
  total: number; // size of the ranked field
  level: number; // volume tier L1..L6 (coarse — intended public, like a veteran badge)
  // NB: exact P/L + volume are intentionally NOT exposed here. This endpoint is public + enumerable, and
  // the leaderboard only publishes figures for the top-N — returning them per-user would widen that to
  // everyone. Re-add (with scoping) only when the hover UI is meant to show them.
}

/** Public profile card for the chat hover popover: identity + leaderboard standing (rank + level). */
export async function getProfileCard(db: Db, userId: string): Promise<ProfileCard> {
  const u = await db.query<{ dn: string | null; pk: string; av: string | null; is_mod: boolean }>(
    `SELECT display_name AS dn, solana_pubkey AS pk, avatar AS av, is_mod FROM users WHERE id = $1`,
    [userId],
  );
  if (!u.rows[0]) throw new HttpError(404, 'user not found');
  const s = await userStanding(db, userId);
  return { userId, handle: handleFor(u.rows[0].dn, u.rows[0].pk), avatar: u.rows[0].av, isMod: u.rows[0].is_mod, rank: s.rank, total: s.total, level: s.level };
}

/**
 * Set (rename) the caller's chat username. Validated + unique case-insensitively. Renaming RESERVES
 * the freed handle (display_name_aliases) so nobody else can claim it and impersonate the original
 * owner in chat — the same anti-hijack pattern as referral codes. Uniqueness spans live names AND
 * reserved aliases; the unique index (a caught 23505) closes the race against a concurrent claim.
 */
export async function setUsername(db: Db, userId: string, rawName: string): Promise<{ username: string }> {
  const name = rawName.trim();
  if (name.length < 3 || name.length > 20 || !/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new HttpError(400, 'username must be 3-20 characters: letters, numbers, _ and -');
  }
  const lower = name.toLowerCase();

  return db.tx(async (q) => {
    const cur = await q.query<{ display_name: string | null }>(`SELECT display_name FROM users WHERE id = $1`, [userId]);
    const current = cur.rows[0]?.display_name ?? null;
    if (current === name) return { username: name }; // no-op (matches setReferralCode)

    // uniqueness spans live names AND reserved (renamed-away) aliases, excluding this user's own
    const taken = await q.query(
      `SELECT 1 FROM users WHERE lower(display_name) = $1 AND id <> $2
       UNION ALL SELECT 1 FROM display_name_aliases WHERE name_lower = $1 AND user_id <> $2`,
      [lower, userId],
    );
    if (taken.rows[0]) throw new HttpError(409, 'that username is already taken');

    // reserve the prior handle permanently so it can't be hijacked to impersonate this user
    if (current) {
      await q.query(
        `INSERT INTO display_name_aliases(name_lower, user_id) VALUES(lower($1), $2) ON CONFLICT(name_lower) DO NOTHING`,
        [current, userId],
      );
    }
    try {
      await q.query(`UPDATE users SET display_name = $1 WHERE id = $2`, [name, userId]);
    } catch (e) {
      if ((e as { code?: string })?.code === '23505') throw new HttpError(409, 'that username is already taken');
      throw e;
    }
    // if the new name was previously this user's reserved alias, it's now their live name again
    await q.query(`DELETE FROM display_name_aliases WHERE name_lower = $1 AND user_id = $2`, [lower, userId]);
    return { username: name };
  });
}

const AVATAR_RE = /^(default|shiny)\/(\d{1,4})\.png$/; // a sprite bundled under apps/web/public/avatars/
const AVATAR_DEX_MAX = 649; // #1–649 ship in both default/ and shiny/ (matches the web picker's range)

/** Set the caller's profile avatar — a sprite path under /avatars/, validated to the EXACT bundled set
 *  (dir + #1–649) so we never persist a value with no sprite file behind it. */
export async function setAvatar(db: Db, userId: string, rawAvatar: string): Promise<{ avatar: string }> {
  const avatar = rawAvatar.trim();
  const m = AVATAR_RE.exec(avatar);
  const n = m ? Number(m[2]) : 0;
  if (!m || n < 1 || n > AVATAR_DEX_MAX) throw new HttpError(400, 'invalid avatar');
  const r = await db.query<{ id: string }>(`UPDATE users SET avatar = $1 WHERE id = $2 RETURNING id`, [avatar, userId]);
  if (!r.rows[0]) throw new HttpError(404, 'user not found');
  return { avatar };
}

export interface ChatUserRow {
  userId: string;
  handle: string;
  pubkey: string; // their connected Solana wallet
  messages: number; // lifetime chat messages posted
  lastAt: string; // last message timestamp
  isMod: boolean;
}

/**
 * Operator view of everyone who has been active in chat — posted >=1 real message — with their connected
 * wallet, message count, and last-active time, most-active first. For the admin CHAT view. Action-bar /
 * system rows (kind != 'message') and authorless rows are excluded by the join.
 */
export async function listChatUsers(db: Db, limit = 500): Promise<ChatUserRow[]> {
  const r = await db.query<{ id: string; pk: string; dn: string | null; is_mod: boolean; cnt: string; last_at: string }>(
    `SELECT u.id, u.solana_pubkey AS pk, u.display_name AS dn, u.is_mod,
            COUNT(m.id)::text AS cnt, MAX(m.created_at) AS last_at
     FROM users u
     JOIN chat_messages m ON m.user_id = u.id AND m.kind = 'message'
     GROUP BY u.id, u.solana_pubkey, u.display_name, u.is_mod
     ORDER BY COUNT(m.id) DESC, MAX(m.created_at) DESC
     LIMIT $1`,
    [limit],
  );
  return r.rows.map((x) => ({
    userId: x.id,
    handle: handleFor(x.dn, x.pk),
    pubkey: x.pk,
    messages: Number(x.cnt),
    lastAt: x.last_at,
    isMod: x.is_mod,
  }));
}
