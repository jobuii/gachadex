import { CHAT_REACTIONS } from '@pokex/shared-types';
import { HttpError } from '../errors.ts';
import type { Db } from '../db/client.ts';
import { publish } from './bus.ts';

/**
 * Emoji reactions. A reaction is one row per (message, user, emoji); reacting toggles it. Only the
 * whitelisted CHAT_REACTIONS are allowed, and you can't react to a deleted message. Each toggle
 * broadcasts a `reaction` event with the emoji's new count so every client updates live.
 */
export async function toggleReaction(
  db: Db,
  userId: string,
  messageId: string,
  emoji: string,
): Promise<{ messageId: string; emoji: string; count: number; added: boolean }> {
  if (!CHAT_REACTIONS.includes(emoji)) throw new HttpError(400, 'unsupported reaction');

  const result = await db.tx(async (q) => {
    const m = await q.query(`SELECT 1 FROM chat_messages WHERE id = $1 AND deleted_at IS NULL`, [messageId]);
    if (!m.rows[0]) throw new HttpError(404, 'message not found');

    // toggle: a delete that removed a row means it was on -> now off; otherwise insert it
    const del = await q.query(`DELETE FROM chat_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3 RETURNING message_id`, [messageId, userId, emoji]);
    const added = del.rows.length === 0;
    if (added) {
      await q.query(
        `INSERT INTO chat_reactions(message_id, user_id, emoji) VALUES($1, $2, $3) ON CONFLICT DO NOTHING`,
        [messageId, userId, emoji],
      );
    }
    const c = await q.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM chat_reactions WHERE message_id = $1 AND emoji = $2`, [messageId, emoji]);
    return { count: c.rows[0].n, added };
  });

  // broadcast only the new count (not who reacted) — clients show counts + the viewer's own, not a reactor list
  publish('chat', 'reaction', { messageId, emoji, count: result.count });
  return { messageId, emoji, ...result };
}
