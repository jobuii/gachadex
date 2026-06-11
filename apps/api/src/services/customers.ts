import type { Db } from '../db/client.ts';

/**
 * Operator view of individual customers (admin dashboard "Customers" tab). One row per user, joining
 * their wallet + deposit address, ledger balances (free collateral / margin locked in open trades), and
 * lifetime trading stats aggregated from `fills` (volume = Σ notional, fees paid, realized P/L). Read-only.
 */
export interface CustomerRow {
  userId: string;
  pubkey: string; // their connected wallet
  displayName: string | null;
  status: string;
  joinedAt: string;
  depositAddress: string | null;
  freeE6: string; // available collateral (USER_COLLATERAL)
  lockedE6: string; // margin locked in open positions (USER_POSITION_MARGIN)
  volumeE6: string; // lifetime traded notional (Σ qty*price over fills)
  feesE6: string; // lifetime trading fees paid
  pnlE6: string; // lifetime realized P/L (can be negative)
  openPositions: number;
}

// Sort key -> the numeric ORDER BY expression. The key comes from the client, so it MUST be whitelisted
// here (never interpolate raw input); an unknown key falls back to volume.
const SORT_EXPR: Record<string, string> = {
  volume: 'COALESCE(vol.volume_e6, 0)',
  fees: 'COALESCE(vol.fees_e6, 0)',
  free: 'COALESCE(coll.amount_uusdc, 0)',
  locked: 'COALESCE(marg.amount_uusdc, 0)',
  pnl: 'COALESCE(vol.pnl_e6, 0)',
  joined: 'u.created_at',
};

export async function listCustomers(
  db: Db,
  opts: { limit: number; offset: number; sort: string },
): Promise<{ customers: CustomerRow[]; total: number }> {
  const orderBy = SORT_EXPR[opts.sort] ?? SORT_EXPR.volume;
  const [r, totalR] = await Promise.all([
    db.query<{
    id: string;
    solana_pubkey: string;
    display_name: string | null;
    status: string;
    joined_at: string;
    deposit_address: string | null;
    free_e6: string;
    locked_e6: string;
    volume_e6: string;
    fees_e6: string;
    pnl_e6: string;
    open_positions: number;
  }>(
    // qty/price are 1e6 fixed-point, so notional (uUSDC) = Σ(qty*price)/1e6; numeric avoids bigint overflow.
    `WITH vol AS (
       SELECT p.user_id,
              FLOOR(SUM(fl.qty_e6::numeric * fl.exec_price_e6) / 1000000) AS volume_e6,
              SUM(fl.fee_uusdc) AS fees_e6,
              SUM(fl.realized_pnl_uusdc) AS pnl_e6
       FROM fills fl JOIN positions p ON p.id = fl.position_id
       GROUP BY p.user_id
     ),
     op AS (
       SELECT user_id, COUNT(*) AS open_positions FROM positions WHERE status = 'open' GROUP BY user_id
     )
     SELECT u.id, u.solana_pubkey, u.display_name, u.status,
            u.created_at::text AS joined_at,
            da.address AS deposit_address,
            COALESCE(coll.amount_uusdc, 0)::text AS free_e6,
            COALESCE(marg.amount_uusdc, 0)::text AS locked_e6,
            COALESCE(vol.volume_e6, 0)::text AS volume_e6,
            COALESCE(vol.fees_e6, 0)::text AS fees_e6,
            COALESCE(vol.pnl_e6, 0)::text AS pnl_e6,
            COALESCE(op.open_positions, 0)::int AS open_positions
     FROM users u
     LEFT JOIN deposit_addresses da ON da.user_id = u.id
     LEFT JOIN accounts ca ON ca.user_id = u.id AND ca.type = 'USER_COLLATERAL'
     LEFT JOIN balances coll ON coll.account_id = ca.id
     LEFT JOIN accounts ma ON ma.user_id = u.id AND ma.type = 'USER_POSITION_MARGIN'
     LEFT JOIN balances marg ON marg.account_id = ma.id
     LEFT JOIN vol ON vol.user_id = u.id
     LEFT JOIN op ON op.user_id = u.id
     ORDER BY ${orderBy} DESC NULLS LAST, u.created_at DESC
     LIMIT $1 OFFSET $2`,
      [opts.limit, opts.offset],
    ),
    db.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM users`),
  ]);
  return {
    customers: r.rows.map((x) => ({
      userId: x.id,
      pubkey: x.solana_pubkey,
      displayName: x.display_name,
      status: x.status,
      joinedAt: x.joined_at,
      depositAddress: x.deposit_address,
      freeE6: x.free_e6,
      lockedE6: x.locked_e6,
      volumeE6: x.volume_e6,
      feesE6: x.fees_e6,
      pnlE6: x.pnl_e6,
      openPositions: x.open_positions,
    })),
    total: Number(totalR.rows[0].c),
  };
}
