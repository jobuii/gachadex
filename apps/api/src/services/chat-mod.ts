import { randomUUID } from 'node:crypto';
import { HttpError } from '../errors.ts';
import type { Db, Queryer } from '../db/client.ts';
import { publish } from './bus.ts';
import { handleFor } from './handles.ts';

/**
 * Chat moderation: mods (and the operator via the admin key) can soft-delete messages, mute/ban users,
 * and the operator can grant/revoke mod. Every action is recorded in chat_mod_actions (append-only audit).
 * Mods cannot moderate other mods — operators manage mods. Enforcement of mute/ban on posting lives in
 * postChat (chat.ts); this module is the action surface.
 */

export type ModAction = 'delete' | 'mute' | 'unmute' | 'ban' | 'unban' | 'grant_mod' | 'revoke_mod';
const DEFAULT_MUTE_MIN = 60;
const MAX_MUTE_MIN = 43_200; // 30 days

/** Append an audit row. modUserId NULL = operator (admin key). Runs inside the caller's tx. */
async function audit(
  q: Queryer,
  modUserId: string | null,
  action: ModAction,
  opts: { targetUserId?: string | null; targetMessageId?: string | null; detail?: string | null } = {},
): Promise<void> {
  await q.query(
    `INSERT INTO chat_mod_actions(id, mod_user_id, action, target_user_id, target_message_id, detail)
     VALUES($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), modUserId, action, opts.targetUserId ?? null, opts.targetMessageId ?? null, opts.detail ?? null],
  );
}

/** Broadcast a user's current mute/ban snapshot on the public chat channel — the affected user's client
 *  disables its input live, and mods' mute/ban buttons flip to unmute/unban without a refresh. */
function publishModState(userId: string, state: { mu: string | null; banned: boolean }): void {
  publish('chat', 'modstate', { userId, mutedUntil: state.mu, banned: state.banned });
}

/** A mod may not moderate another mod (operators manage mods). Throws 404/403. */
async function assertModeratable(q: Queryer, targetUserId: string): Promise<void> {
  const r = await q.query<{ is_mod: boolean }>(`SELECT is_mod FROM users WHERE id = $1`, [targetUserId]);
  if (!r.rows[0]) throw new HttpError(404, 'user not found');
  if (r.rows[0].is_mod) throw new HttpError(403, 'cannot moderate another moderator');
}

/** Soft-delete a message (kept for audit; listChat filters it). Broadcasts so clients remove it live. */
export async function deleteMessage(db: Db, modUserId: string, messageId: string): Promise<{ id: string }> {
  await db.tx(async (q) => {
    const r = await q.query<{ user_id: string }>(
      `UPDATE chat_messages SET deleted_at = now(), deleted_by = $2 WHERE id = $1 AND deleted_at IS NULL RETURNING user_id`,
      [messageId, modUserId],
    );
    if (!r.rows[0]) throw new HttpError(404, 'message not found or already deleted');
    await audit(q, modUserId, 'delete', { targetUserId: r.rows[0].user_id, targetMessageId: messageId });
  });
  publish('chat', 'delete', { id: messageId });
  return { id: messageId };
}

type ModSnapshot = { mu: string | null; banned: boolean };

/** Mute a user for N minutes (default 60, capped 30 days). modUserId NULL = operator. */
export async function muteUser(db: Db, modUserId: string | null, targetUserId: string, minutes?: number): Promise<{ userId: string; minutes: number; mutedUntil: string | null }> {
  const mins = Math.min(Math.max(Math.floor(minutes ?? DEFAULT_MUTE_MIN), 1), MAX_MUTE_MIN);
  const state = await db.tx(async (q) => {
    await assertModeratable(q, targetUserId);
    const r = await q.query<ModSnapshot>(
      `UPDATE users SET chat_muted_until = now() + ($2::int * interval '1 minute') WHERE id = $1
       RETURNING chat_muted_until AS mu, chat_banned AS banned`,
      [targetUserId, mins],
    );
    await audit(q, modUserId, 'mute', { targetUserId, detail: `${mins}m` });
    return r.rows[0];
  });
  publishModState(targetUserId, state);
  return { userId: targetUserId, minutes: mins, mutedUntil: state.mu };
}

export async function unmuteUser(db: Db, modUserId: string | null, targetUserId: string): Promise<{ userId: string }> {
  const state = await db.tx(async (q) => {
    const r = await q.query<ModSnapshot>(
      `UPDATE users SET chat_muted_until = NULL WHERE id = $1 RETURNING chat_muted_until AS mu, chat_banned AS banned`,
      [targetUserId],
    );
    if (!r.rows[0]) throw new HttpError(404, 'user not found');
    await audit(q, modUserId, 'unmute', { targetUserId });
    return r.rows[0];
  });
  publishModState(targetUserId, state);
  return { userId: targetUserId };
}

export async function setBanned(db: Db, modUserId: string | null, targetUserId: string, banned: boolean): Promise<{ userId: string; banned: boolean }> {
  const state = await db.tx(async (q) => {
    if (banned) await assertModeratable(q, targetUserId); // can't ban a mod; unban just clears the flag
    const r = await q.query<ModSnapshot>(
      `UPDATE users SET chat_banned = $2 WHERE id = $1 RETURNING chat_muted_until AS mu, chat_banned AS banned`,
      [targetUserId, banned],
    );
    if (!r.rows[0]) throw new HttpError(404, 'user not found');
    await audit(q, modUserId, banned ? 'ban' : 'unban', { targetUserId });
    return r.rows[0];
  });
  publishModState(targetUserId, state);
  return { userId: targetUserId, banned };
}

/** Operator-only (admin key): grant/revoke moderator status. byModUserId NULL = operator. */
export async function setMod(db: Db, targetUserId: string, isMod: boolean, byModUserId: string | null = null): Promise<{ userId: string; isMod: boolean }> {
  return db.tx(async (q) => {
    const r = await q.query(`UPDATE users SET is_mod = $2 WHERE id = $1 RETURNING id`, [targetUserId, isMod]);
    if (!r.rows[0]) throw new HttpError(404, 'user not found');
    await audit(q, byModUserId, isMod ? 'grant_mod' : 'revoke_mod', { targetUserId });
    return { userId: targetUserId, isMod };
  });
}

/**
 * Resolve an admin-supplied identifier (an internal user id OR a Solana wallet pubkey) to a user id.
 * The operator thinks in wallets, but moderation acts on user ids — this lets the admin CHAT view grant
 * MOD by pasting a wallet. Returns null when no user matches.
 */
export async function resolveChatUserId(db: Db, idOrPubkey: string): Promise<string | null> {
  const r = await db.query<{ id: string }>(
    `SELECT id FROM users WHERE id = $1 OR solana_pubkey = $1 LIMIT 1`,
    [idOrPubkey],
  );
  return r.rows[0]?.id ?? null;
}

export interface ModStateRow {
  userId: string;
  handle: string;
  mutedUntil?: string | null;
}
export interface ModState {
  mods: ModStateRow[];
  muted: ModStateRow[];
  banned: ModStateRow[];
  recentActions: { id: string; modHandle: string | null; action: string; targetHandle: string | null; detail: string | null; at: string }[];
}

/** Snapshot for the admin CHAT view: current mods / muted / banned + recent audit log. */
export async function listModState(db: Db, auditLimit = 50): Promise<ModState> {
  const mods = await db.query<{ id: string; dn: string | null; pk: string }>(
    `SELECT id, display_name AS dn, solana_pubkey AS pk FROM users WHERE is_mod ORDER BY display_name NULLS LAST`,
  );
  const muted = await db.query<{ id: string; dn: string | null; pk: string; mu: string }>(
    `SELECT id, display_name AS dn, solana_pubkey AS pk, chat_muted_until AS mu FROM users
     WHERE chat_muted_until IS NOT NULL AND chat_muted_until > now() ORDER BY chat_muted_until DESC`,
  );
  const banned = await db.query<{ id: string; dn: string | null; pk: string }>(
    `SELECT id, display_name AS dn, solana_pubkey AS pk FROM users WHERE chat_banned ORDER BY display_name NULLS LAST`,
  );
  const actions = await db.query<{ id: string; action: string; detail: string | null; at: string; m_dn: string | null; m_pk: string | null; t_dn: string | null; t_pk: string | null }>(
    `SELECT a.id, a.action, a.detail, a.created_at AS at,
            m.display_name AS m_dn, m.solana_pubkey AS m_pk, t.display_name AS t_dn, t.solana_pubkey AS t_pk
     FROM chat_mod_actions a
     LEFT JOIN users m ON m.id = a.mod_user_id
     LEFT JOIN users t ON t.id = a.target_user_id
     ORDER BY a.created_at DESC LIMIT $1`,
    [auditLimit],
  );
  const row = (r: { id: string; dn: string | null; pk: string; mu?: string }): ModStateRow => ({ userId: r.id, handle: handleFor(r.dn, r.pk), mutedUntil: r.mu ?? null });
  return {
    mods: mods.rows.map(row),
    muted: muted.rows.map((r) => ({ ...row(r), mutedUntil: r.mu })),
    banned: banned.rows.map(row),
    recentActions: actions.rows.map((a) => ({
      id: a.id,
      modHandle: a.m_pk ? handleFor(a.m_dn, a.m_pk) : null, // null = operator (admin key)
      action: a.action,
      targetHandle: a.t_pk ? handleFor(a.t_dn, a.t_pk) : null,
      detail: a.detail,
      at: a.at,
    })),
  };
}
