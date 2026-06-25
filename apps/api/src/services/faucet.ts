import { config } from '../config.ts';
import { HttpError } from '../errors.ts';
import type { Db, Queryer } from '../db/client.ts';
import { getOrCreateUserAccount, getOrCreateSystemAccount, postTxn, getBalance } from './ledger.ts';
import { usdc } from '../money.ts';

/** Play-money cap: don't let a user's available balance exceed this (faucet + referral bonus). */
const MAX_AVAILABLE_UUSDC = usdc(1_000_000);

export interface UserBalances {
  availableUusdc: bigint;
  lockedMarginUusdc: bigint;
  reservedUusdc: bigint; // margin earmarked against resting limit orders (docs/limit-stop-orders-spec.md)
  equityUusdc: bigint; // available + locked + reserved (+ unrealized PnL once the engine lands)
}

export async function getUserBalances(db: Db, userId: string): Promise<UserBalances> {
  // single read; accounts get created on first faucet/trade, absent rows read as 0
  const r = await db.query<{ type: string; amt: string }>(
    `SELECT a.type, COALESCE(b.amount_uusdc, 0)::text AS amt
     FROM accounts a LEFT JOIN balances b ON b.account_id = a.id
     WHERE a.user_id = $1 AND a.type IN ('USER_COLLATERAL', 'USER_POSITION_MARGIN', 'RESTING_ORDER_MARGIN')`,
    [userId],
  );
  let availableUusdc = 0n;
  let lockedMarginUusdc = 0n;
  let reservedUusdc = 0n;
  for (const row of r.rows) {
    if (row.type === 'USER_COLLATERAL') availableUusdc = BigInt(row.amt);
    else if (row.type === 'USER_POSITION_MARGIN') lockedMarginUusdc = BigInt(row.amt);
    else if (row.type === 'RESTING_ORDER_MARGIN') reservedUusdc = BigInt(row.amt);
  }
  // reserved margin is still the user's equity — it just can't be spent while the order rests. Counting it
  // keeps displayed equity whole when an order is placed (collateral simply moves into the reserve).
  return { availableUusdc, lockedMarginUusdc, reservedUusdc, equityUusdc: availableUusdc + lockedMarginUusdc + reservedUusdc };
}

/**
 * Credit play USDC to a user from FAUCET_SOURCE, clamped so their available balance can't exceed the
 * play-money cap. Returns the amount actually credited (0n if already at the cap) + the txn id. The
 * single home for the cap-and-clamp rule — the faucet and the referral bonus both go through it.
 */
export async function creditCapped(
  q: Queryer,
  userId: string,
  amount: bigint,
  reason: string,
  ref?: { refType: string; refId: string },
): Promise<{ credited: bigint; txnId: string | null }> {
  if (amount <= 0n) return { credited: 0n, txnId: null };
  const coll = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
  const faucet = await getOrCreateSystemAccount(q, 'FAUCET_SOURCE');
  const headroom = MAX_AVAILABLE_UUSDC - (await getBalance(q, coll));
  if (headroom <= 0n) return { credited: 0n, txnId: null };
  const credit = amount < headroom ? amount : headroom; // clamp so balance can't exceed the cap
  const txnId = await postTxn(q, {
    reason,
    refType: ref?.refType,
    refId: ref?.refId,
    entries: [
      { accountId: coll, amount: credit },
      { accountId: faucet, amount: -credit },
    ],
  });
  return { credited: credit, txnId };
}

/** Credit the faucet's default play USDC; rejects with 429 once the user is at the cap. */
export async function creditFaucet(db: Db, userId: string, amountUsd?: number): Promise<{ txnId: string; availableUusdc: bigint }> {
  if (config.realFunds) throw new HttpError(403, 'faucet disabled when REAL_FUNDS is on');
  const amount = usdc(amountUsd ?? config.faucetDefaultUsd);
  if (amount <= 0n) throw new HttpError(400, 'amount must be positive');

  const { credited, txnId } = await db.tx((q) => creditCapped(q, userId, amount, 'FAUCET'));
  if (credited <= 0n || !txnId) throw new HttpError(429, 'faucet limit reached — you already have plenty of play USDC');

  const balances = await getUserBalances(db, userId);
  return { txnId, availableUusdc: balances.availableUusdc };
}
