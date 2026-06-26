import { HttpError } from '../errors.ts';
import type { Db } from '../db/client.ts';
import { getOrCreateSystemAccount, getBalance, getBalanceForUpdate, postTxn } from './ledger.ts';

/**
 * The insurance fund is the buffer that absorbs gap-driven bad debt (a liquidation that blows past
 * the trader's margin) BEFORE it socializes to LPs. Loss waterfall: trader margin -> insurance -> LP.
 *
 * It auto-fills from the 1% liquidation penalty. These let an operator pre-seed / top it up from
 * HOUSE money — never from money owed to users. Two sources:
 *   (a) accumulated platform fees (FEE_REVENUE): pure ledger move, house earnings already in custody.
 *   (b) treasury surplus: real USDC the operator has sent into the treasury (on-chain reserves beyond
 *       liabilities). The caller verifies the surplus against the live on-chain balance first, so you
 *       can never allocate money that isn't actually there (which would otherwise trip a PoR breach).
 * No real USDC moves on-chain in any of these — they only re-label which house bucket holds the claim.
 */

/** (a) Move accumulated platform fees into the insurance buffer. */
export async function allocateFeesToInsurance(db: Db, amountUusdc: bigint): Promise<{ insuranceUusdc: string; feeRevenueUusdc: string }> {
  if (amountUusdc <= 0n) throw new HttpError(400, 'amount must be positive');
  return db.tx(async (q) => {
    const fees = await getOrCreateSystemAccount(q, 'FEE_REVENUE');
    const ins = await getOrCreateSystemAccount(q, 'INSURANCE_FUND');
    if ((await getBalanceForUpdate(q, fees)) < amountUusdc) throw new HttpError(400, 'fee revenue balance too low'); // lock: no concurrent over-draw
    await postTxn(q, {
      reason: 'INSURANCE_FROM_FEES',
      entries: [
        { accountId: fees, amount: -amountUusdc },
        { accountId: ins, amount: amountUusdc },
      ],
    });
    return { insuranceUusdc: (await getBalance(q, ins)).toString(), feeRevenueUusdc: (await getBalance(q, fees)).toString() };
  });
}

/** Reverse of (a): pull from the insurance buffer back to platform fee revenue (operator rebalance). */
export async function deallocateInsuranceToFees(db: Db, amountUusdc: bigint): Promise<{ insuranceUusdc: string; feeRevenueUusdc: string }> {
  if (amountUusdc <= 0n) throw new HttpError(400, 'amount must be positive');
  return db.tx(async (q) => {
    const fees = await getOrCreateSystemAccount(q, 'FEE_REVENUE');
    const ins = await getOrCreateSystemAccount(q, 'INSURANCE_FUND');
    // Canonical lock order — take the FEE_REVENUE row-lock FIRST (matching allocateFeesToInsurance + the gacha
    // sweep) so these inverse house-account moves can never ABBA-deadlock; then lock + cap-check the source.
    await getBalanceForUpdate(q, fees);
    if ((await getBalanceForUpdate(q, ins)) < amountUusdc) throw new HttpError(400, 'insurance fund balance too low');
    await postTxn(q, {
      reason: 'INSURANCE_TO_FEES',
      entries: [
        { accountId: ins, amount: -amountUusdc },
        { accountId: fees, amount: amountUusdc },
      ],
    });
    return { insuranceUusdc: (await getBalance(q, ins)).toString(), feeRevenueUusdc: (await getBalance(q, fees)).toString() };
  });
}

/**
 * (b) Allocate operator-injected treasury surplus into insurance. `availableSurplusUusdc` is the
 * live on-chain surplus (reserves − liabilities) the caller read from treasuryState — the amount is
 * capped to it so a misclick can't record insurance that isn't backed by real custody USDC. Records
 * the claim against TREASURY_USDC (mirroring a deposit), keeping reserves == liabilities afterward.
 */
export async function allocateTreasurySurplusToInsurance(
  db: Db,
  amountUusdc: bigint,
  availableSurplusUusdc: bigint,
): Promise<{ insuranceUusdc: string }> {
  if (amountUusdc <= 0n) throw new HttpError(400, 'amount must be positive');
  if (amountUusdc > availableSurplusUusdc) {
    throw new HttpError(400, `amount exceeds available treasury surplus (${availableSurplusUusdc} uUSDC) — send funds to the treasury first`);
  }
  return db.tx(async (q) => {
    const ins = await getOrCreateSystemAccount(q, 'INSURANCE_FUND');
    const treasury = await getOrCreateSystemAccount(q, 'TREASURY_USDC');
    await postTxn(q, {
      reason: 'INSURANCE_FROM_TREASURY',
      entries: [
        { accountId: ins, amount: amountUusdc },
        { accountId: treasury, amount: -amountUusdc },
      ],
    });
    return { insuranceUusdc: (await getBalance(q, ins)).toString() };
  });
}

/** Current insurance-fund balance (micro-USDC). */
export async function getInsurance(db: Db): Promise<{ insuranceUusdc: string }> {
  const ins = await getOrCreateSystemAccount(db, 'INSURANCE_FUND');
  return { insuranceUusdc: (await getBalance(db, ins)).toString() };
}
