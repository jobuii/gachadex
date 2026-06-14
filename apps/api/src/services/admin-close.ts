import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client.ts';
import { closePosition, getUserPositions } from './engine.ts';

/**
 * Operator-initiated position closes (admin panel). Reuses the normal `closePosition` engine path, so
 * margin/PnL/funding/fees settle exactly as a user close would — the only difference is the audit
 * marker: the reduce-only order is stamped with PLATFORM_ACTOR as its actor, so a platform close is
 * distinguishable from a self-close in `orders.actor_pubkey`.
 *
 * Three scopes: one position, all of one customer's positions, and the platform-wide kill switch.
 * Each is best-effort per position — a position that can't be voluntarily closed (e.g. it's
 * liquidatable, which the engine routes through liquidation instead) is reported as failed, not fatal.
 */
export const PLATFORM_ACTOR = 'PLATFORM_ADMIN'; // orders.actor_pubkey marker = "manual close by platform"

export interface AdminCloseResult {
  closed: number;
  failed: number;
  errors: { positionId: string; error: string }[];
}

/** Close one position on a user's behalf (full close). Throws if the engine refuses (caller surfaces it). */
export async function adminClosePosition(db: Db, userId: string, positionId: string): Promise<{ realizedPnlUusdc: string }> {
  const r = await closePosition(db, userId, {
    positionId,
    fractionBps: 10_000,
    idempotencyKey: `admin-close-${positionId}-${randomUUID()}`,
    actorPubkey: PLATFORM_ACTOR,
  });
  return { realizedPnlUusdc: r.realizedPnlUusdc };
}

/** Close every open position for one customer. Best-effort: collects per-position failures. */
export async function adminCloseUserPositions(db: Db, userId: string): Promise<AdminCloseResult> {
  const positions = await getUserPositions(db, userId);
  return closeEach(
    db,
    positions.map((p) => ({ userId, positionId: p.id })),
  );
}

/** EMERGENCY: close EVERY open position across ALL customers. Best-effort, sequential. */
export async function adminCloseAllPositions(db: Db): Promise<AdminCloseResult> {
  const rows = await db.query<{ id: string; user_id: string }>(`SELECT id, user_id FROM positions WHERE status = 'open'`);
  return closeEach(
    db,
    rows.rows.map((r) => ({ userId: r.user_id, positionId: r.id })),
  );
}

async function closeEach(db: Db, targets: { userId: string; positionId: string }[]): Promise<AdminCloseResult> {
  const out: AdminCloseResult = { closed: 0, failed: 0, errors: [] };
  for (const t of targets) {
    try {
      await adminClosePosition(db, t.userId, t.positionId);
      out.closed++;
    } catch (e) {
      out.failed++;
      out.errors.push({ positionId: t.positionId, error: (e as Error).message });
    }
  }
  return out;
}
