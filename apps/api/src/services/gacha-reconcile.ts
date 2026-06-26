import type { Db } from '../db/client.ts';
import { config } from '../config.ts';
import { getAssetTransferInfo } from './das.ts';
import { gachaConfig } from './gacha-config.ts';
import { settleSoldPrize } from './gacha-settle.ts';
import { defaultCcClient, type CcClient } from './providers/collectorcrypt.ts';

/**
 * Recover Classic Gacha inventory rows stranded in 'selling' / 'withdrawing' by a hard crash mid-flight
 * (docs/classic-gacha-cc-packs-spec.md §9/§16 — "recovers in-flight on boot"). The normal caught-error paths in
 * sellBack / requestNftWithdraw self-heal to 'held' ONLY when the NFT is DAS-confirmed still in custody (else
 * they leave the row 'selling'/'withdrawing' for this reconciler); a row also sticks if the PROCESS dies between
 * the claim and the settle/revert. The on-chain NFT owner (via DAS) is the oracle:
 *   • still in the user's custody wallet  → the on-chain op never moved it → release to 'held' (retry-able).
 *   • 'withdrawing' + NFT left custody    → the transfer landed → mark 'withdrawn'.
 *   • 'selling' + NFT left custody        → the buyback executed but the ledger was never settled, so the user is
 *                                           owed USDC. Fetch CC's CONFIRMED buyback amount (getPackStatus) and
 *                                           auto-settle (credit the seller, same posting as a live sell-back); if
 *                                           CC reports no amount, FLAG it (loud log) for an operator to settle.
 * Grace (default 300s): only rows whose last state change (settled_at, stamped on the claim) is older than
 * `graceSec`, so a LIVE in-flight op is never touched. This is safe because a live sell-back/withdraw can only
 * hold 'selling'/'withdrawing' briefly: the CC client caps every call at a 15s abort timeout with ~2 retries
 * (≈100s worst case for buyback+submit), and the on-chain tx confirms within the Solana blockhash window (~90s)
 * or expires — so a row still stuck past 300s is crash-stranded, with no live settle to race. (And 'selling' +
 * NFT-gone settles-or-flags, never reverts, so even a confirmed-but-not-yet-settled buyback is never stranded.)
 * DAS-unavailable (null) → skip the row (never decide on incomplete info). Every write is status-guarded and
 * idempotent → safe to run on boot and on demand, on any number of instances. `getAssetInfo` is injectable for tests.
 */
export interface StuckReconcileResult { scanned: number; revertedToHeld: number; markedWithdrawn: number; settledSelling: number; flaggedSelling: number; skipped: number }

export async function reconcileStuckPrizes(
  db: Db,
  opts: { graceSec?: number; getAssetInfo?: typeof getAssetTransferInfo; cc?: Pick<CcClient, 'getPackStatus'> } = {},
): Promise<StuckReconcileResult> {
  const out: StuckReconcileResult = { scanned: 0, revertedToHeld: 0, markedWithdrawn: 0, settledSelling: 0, flaggedSelling: 0, skipped: 0 };
  if (!config.classicGachaEnabled) return out;
  const getInfo = opts.getAssetInfo ?? getAssetTransferInfo;
  const cc = opts.cc ?? defaultCcClient;
  const cutoff = new Date(Date.now() - (opts.graceSec ?? 300) * 1000).toISOString();
  const rows = (await db.query<{ id: string; mint: string; custody_pubkey: string; status: string; user_id: string; cc_memo: string | null }>(
    `SELECT i.id, i.mint, i.custody_pubkey, i.status, i.user_id, o.cc_memo
       FROM gacha_nft_inventory i LEFT JOIN gacha_pack_opens o ON o.id = i.open_id
      WHERE i.status IN ('selling', 'withdrawing') AND (i.settled_at IS NULL OR i.settled_at < $1)`,
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
        // The buyback executed on-chain (NFT gone) but the ledger never settled. Fetch CC's CONFIRMED buyback
        // amount and credit the seller — the same posting a normal sell-back would have done. Cut = the manual
        // buyback knob; a stuck instant-sell would settle a hair in the user's favour (the safe direction).
        let gross = 0n;
        if (r.cc_memo) {
          const st = await cc.getPackStatus(r.cc_memo).catch(() => null);
          const bb = st?.buyback?.find((b) => b.refund_amount != null && Number(b.refund_amount) > 0);
          if (bb) gross = BigInt(Math.trunc(Number(bb.refund_amount)));
        }
        if (gross > 0n) {
          try {
            await db.tx((q) => settleSoldPrize(q, r.id, r.user_id, gross, BigInt(gachaConfig.buybackCutBps.get())));
            out.settledSelling++;
          } catch (settleErr) {
            console.error('[gacha] stuck-reconciler: auto-settle failed (likely already settled by another pass):', { prizeId: r.id }, settleErr);
          }
        } else {
          console.error('[gacha] stuck-reconciler: prize sold on-chain but no confirmed CC buyback amount — operator must credit the user', { prizeId: r.id, mint: r.mint });
          out.flaggedSelling++;
        }
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
