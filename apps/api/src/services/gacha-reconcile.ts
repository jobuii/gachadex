import type { Db } from '../db/client.ts';
import { config } from '../config.ts';
import { getAssetTransferInfo } from './das.ts';

/**
 * Recover Classic Gacha inventory rows stranded in 'selling' / 'withdrawing' by a hard crash mid-flight
 * (docs/classic-gacha-cc-packs-spec.md §9/§16 — "recovers in-flight on boot"). The normal caught-error paths in
 * sellBack / requestNftWithdraw already self-heal to 'held'; a row only sticks if the PROCESS dies between the
 * claim and the settle/revert. The on-chain NFT owner (via DAS) is the oracle:
 *   • still in the user's custody wallet  → the on-chain op never moved it → release to 'held' (retry-able).
 *   • 'withdrawing' + NFT left custody    → the transfer landed → mark 'withdrawn'.
 *   • 'selling' + NFT left custody        → the buyback executed but the ledger was never settled, so the user is
 *                                           owed USDC. We can't auto-credit without the verified buyback amount →
 *                                           FLAG it (loud log) for an operator to settle by hand.
 * Grace (default 300s): only rows whose last state change (settled_at, stamped on the claim) is older than
 * `graceSec`, so a LIVE in-flight op is never touched. This is safe because a live sell-back/withdraw can only
 * hold 'selling'/'withdrawing' briefly: the CC client caps every call at a 15s abort timeout with ~2 retries
 * (≈100s worst case for buyback+submit), and the on-chain tx confirms within the Solana blockhash window (~90s)
 * or expires — so a row still stuck past 300s is crash-stranded, with no live settle to race. (And 'selling' +
 * NFT-gone only FLAGS, never reverts, so even a confirmed-but-not-yet-settled buyback is never stranded by us.)
 * DAS-unavailable (null) → skip the row (never decide on incomplete info). Every write is status-guarded and
 * idempotent → safe to run on boot and on demand, on any number of instances. `getAssetInfo` is injectable for tests.
 */
export interface StuckReconcileResult { scanned: number; revertedToHeld: number; markedWithdrawn: number; flaggedSelling: number; skipped: number }

export async function reconcileStuckPrizes(
  db: Db,
  opts: { graceSec?: number; getAssetInfo?: typeof getAssetTransferInfo } = {},
): Promise<StuckReconcileResult> {
  const out: StuckReconcileResult = { scanned: 0, revertedToHeld: 0, markedWithdrawn: 0, flaggedSelling: 0, skipped: 0 };
  if (!config.classicGachaEnabled) return out;
  const getInfo = opts.getAssetInfo ?? getAssetTransferInfo;
  const cutoff = new Date(Date.now() - (opts.graceSec ?? 300) * 1000).toISOString();
  const rows = (await db.query<{ id: string; mint: string; custody_pubkey: string; status: string }>(
    `SELECT id, mint, custody_pubkey, status FROM gacha_nft_inventory
      WHERE status IN ('selling', 'withdrawing') AND (settled_at IS NULL OR settled_at < $1)`,
    [cutoff],
  )).rows;
  out.scanned = rows.length;

  for (const r of rows) {
    const info = await getInfo(r.mint);
    if (info == null) { out.skipped++; continue; } // DAS down → can't decide; leave it for the next pass
    const inCustody = info.owner === r.custody_pubkey;
    if (r.status === 'selling') {
      if (inCustody) {
        await db.query(`UPDATE gacha_nft_inventory SET status = 'held' WHERE id = $1 AND status = 'selling'`, [r.id]);
        out.revertedToHeld++;
      } else {
        console.error('[gacha] stuck-reconciler: prize sold on-chain but UNSETTLED — operator must credit the user', { prizeId: r.id, mint: r.mint });
        out.flaggedSelling++;
      }
    } else if (inCustody) {
      await db.query(`UPDATE gacha_nft_inventory SET status = 'held', withdraw_dest = NULL WHERE id = $1 AND status = 'withdrawing'`, [r.id]);
      out.revertedToHeld++;
    } else {
      await db.query(`UPDATE gacha_nft_inventory SET status = 'withdrawn', settled_at = now() WHERE id = $1 AND status = 'withdrawing'`, [r.id]);
      out.markedWithdrawn++;
    }
  }
  return out;
}
