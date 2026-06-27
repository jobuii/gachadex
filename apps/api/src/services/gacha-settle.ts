import type { Queryer } from '../db/client.ts';
import { HttpError } from '../errors.ts';
import { getOrCreateUserAccount, getOrCreateSystemAccount, postTxn } from './ledger.ts';
import { resolveGameRevenueAffiliate } from './affiliate.ts';

// Pure-ledger sell-back settle, shared by the live sell-back (gacha.ts) and the stuck-row reconciler
// (gacha-reconcile.ts) so the money math lives in ONE place. No web3 import → safe on the eager admin path.

export interface SellBackResult { prizeId: string; payoutE6: string; cutE6: string }

/** Pay the referring affiliate their game-revenue share of `revenueE6` (gacha house revenue — sell-back cut or
 *  pack markup — GDEX just booked to FEE_REVENUE for this player). Moves bps% from FEE_REVENUE → the affiliate,
 *  clamped to the revenue so FEE_REVENUE can't underflow. No-op when the player wasn't referred or no rate is set.
 *  Mirrors the perp cashback (engine.ts) but keyed off gacha revenue + a SEPARATE knob (cashback stays perps-only).
 *  Call inside the same db.tx that posted the revenue, with `feeAccId` = that FEE_REVENUE account. */
export async function accrueGachaAffiliateShare(q: Queryer, playerUserId: string, feeAccId: string, revenueE6: bigint, refId: string): Promise<void> {
  if (revenueE6 <= 0n) return;
  const aff = await resolveGameRevenueAffiliate(q, playerUserId);
  if (!aff || aff.userId === playerUserId) return;
  const want = (revenueE6 * BigInt(aff.bps)) / 10000n;
  const share = want > revenueE6 ? revenueE6 : want; // clamp so FEE_REVENUE never goes negative
  if (share <= 0n) return;
  const affColl = await getOrCreateUserAccount(q, aff.userId, 'USER_COLLATERAL');
  await postTxn(q, {
    reason: 'GAME_REVENUE_SHARE', refType: 'gacha', refId,
    entries: [{ accountId: feeAccId, amount: -share }, { accountId: affColl, amount: share }],
  });
}

/**
 * Settle a prize whose CC buyback has paid `gross` (USDC base units) to the hot wallet: credit the user
 * gross−cut, book the cut to FEE_REVENUE, raise the TREASURY liability by gross (backed by the USDC that landed
 * in hot), and mark the row 'sold'. Guarded on status='selling' so it settles EXACTLY ONCE — idempotent for
 * retries, the reconciler, and any number of instances. `cutBps` is the GDEX cut (e.g. 500 = 5%, 1000 = 10%).
 */
export async function settleSoldPrize(q: Queryer, prizeId: string, userId: string, gross: bigint, cutBps: bigint): Promise<SellBackResult> {
  const cur = (await q.query<{ status: string }>(`SELECT status FROM gacha_nft_inventory WHERE id = $1 FOR UPDATE`, [prizeId])).rows[0];
  if (!cur || cur.status !== 'selling') throw new HttpError(409, 'prize already settled'); // settle exactly once
  const payout = (gross * (10_000n - cutBps)) / 10_000n; // floor; user gets (1 − cut)
  const cut = gross - payout; // GDEX keeps the remainder
  const coll = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
  const fee = await getOrCreateSystemAccount(q, 'FEE_REVENUE');
  const treasury = await getOrCreateSystemAccount(q, 'TREASURY_USDC');
  const txnId = await postTxn(q, {
    reason: 'GACHA_SELLBACK', refType: 'gacha_prize', refId: prizeId,
    entries: [
      { accountId: coll, amount: payout },
      { accountId: fee, amount: cut },
      { accountId: treasury, amount: -gross }, // liability up by the USDC that landed in the hot wallet
    ],
  });
  await accrueGachaAffiliateShare(q, userId, fee, cut, prizeId); // affiliate share of the sell-back cut (live + reconciler)
  await q.query(`UPDATE gacha_nft_inventory SET status='sold', sell_value_e6=$2, sell_cut_e6=$3, txn_id=$4, settled_at=now() WHERE id=$1`, [prizeId, payout.toString(), cut.toString(), txnId]);
  return { prizeId, payoutE6: payout.toString(), cutE6: cut.toString() };
}
