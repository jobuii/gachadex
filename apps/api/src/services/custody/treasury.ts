import { getLimits } from './limits.ts';
import { config } from '../../config.ts';
import type { Db, Queryer } from '../../db/client.ts';
import { getOrCreateSystemAccount, getBalance } from '../ledger.ts';
import { usdc } from '../../money.ts';
import type { CustodyLog } from './deposits.ts';

/**
 * Treasury automation (custody P3): proof-of-reserves + hot/cold float management.
 *
 * PROOF OF RESERVES. The ledger's TREASURY_USDC balance mirrors real money: its negative
 * balance equals total internal claims. The invariant is
 *
 *     on-chain custody (cold treasury + hot wallet + unswept deposit addresses) >= liabilities
 *
 * checked every pass. On a breach, withdrawals AUTO-FREEZE (the 'withdrawals_frozen' system
 * flag): new requests and new signings are rejected; deposits continue; recovery of
 * already-signed payouts proceeds (those debits are final and re-broadcast is idempotent).
 * Unfreezing is deliberately manual (`unfreezeWithdrawals`) — a PoR breach is an incident.
 *
 * HOT/COLD FLOAT. Deposits consolidate INTO the hot wallet (see deposits/solana sweepAll), so
 * incoming deposits self-fund the payout float — the server never has to sign a cold->hot top-up
 * under normal flow (it can't: cold is a multisig). The hot wallet runs as a BAND: once its balance
 * reaches the cap (hotWalletMaxUsd), the pass drains it down to the floor (hotWalletFloorPct% of the
 * cap) by sweeping the excess to cold — but never below what queued payouts need. So hot oscillates
 * floor..cap. If withdrawals ever outrun deposits and drain hot below pending payouts, a shortfall is
 * flagged for the operator to top up from cold (the one remaining manual multisig action).
 */

/** Chain-facing surface, injectable for tests (same pattern as DepositChain/WithdrawChain). */
export interface TreasuryChain {
  /** Finalized USDC balance of the hot wallet. */
  hotBalance(): Promise<bigint>;
  /** Finalized USDC balance of the cold treasury. */
  coldBalance(): Promise<bigint>;
  /** Move hot-wallet USDC to the cold treasury. Returns the tx signature. */
  sweepToCold(amountE6: bigint): Promise<string>;
}

const FROZEN_KEY = 'withdrawals_frozen';

/** The freeze reason when withdrawals are frozen, else null. Takes a Queryer so the withdrawal
 *  paths can check it inside their own transactions. */
export async function withdrawalsFrozen(q: Queryer): Promise<string | null> {
  const r = await q.query<{ reason: string }>(`SELECT reason FROM system_flags WHERE key = $1`, [FROZEN_KEY]);
  return r.rows[0]?.reason ?? null;
}

export async function freezeWithdrawals(db: Db, reason: string): Promise<void> {
  await db.query(
    `INSERT INTO system_flags(key, reason) VALUES($1, $2)
     ON CONFLICT(key) DO UPDATE SET reason = EXCLUDED.reason, updated_at = now()`,
    [FROZEN_KEY, reason],
  );
}

/** Operator action — a freeze never clears itself. */
export async function unfreezeWithdrawals(db: Db): Promise<void> {
  await db.query(`DELETE FROM system_flags WHERE key = $1`, [FROZEN_KEY]);
}

// A small (non-material) PoR breach is most likely a transient measurement blip — e.g. RPC lag at a deposit-sweep
// hand-off, where a just-swept deposit has dropped out of `unswept` but the hot-balance read hasn't caught up.
// We only freeze on it if it PERSISTS past treasuryBreachGraceMs. The marker (a `por_breach_since` system_flags
// row, JSON in `reason`) records when the current breach EPISODE began + a counter of consecutive solvent passes.
// The episode only ends after treasuryBreachClearPasses solvent passes IN A ROW, so a breach that intermittently
// flickers solvent (e.g. the over-count window at a sweep hand-off) can't keep resetting the streak and dodging the
// freeze. Survives restarts + coordinates across instances. A MATERIAL breach skips the grace entirely (see treasuryPass).
const BREACH_SINCE_KEY = 'por_breach_since';
interface BreachMarker { start: number; solventPasses: number }

async function getBreachMarker(db: Db): Promise<BreachMarker | null> {
  const r = await db.query<{ reason: string }>(`SELECT reason FROM system_flags WHERE key = $1`, [BREACH_SINCE_KEY]);
  if (!r.rows[0]) return null;
  try {
    const m = JSON.parse(r.rows[0].reason) as Partial<BreachMarker>;
    return typeof m.start === 'number' ? { start: m.start, solventPasses: m.solventPasses ?? 0 } : null;
  } catch {
    return null;
  }
}
async function setBreachMarker(db: Db, m: BreachMarker): Promise<void> {
  await db.query(
    `INSERT INTO system_flags(key, reason) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET reason = EXCLUDED.reason, updated_at = now()`,
    [BREACH_SINCE_KEY, JSON.stringify(m)],
  );
}
async function clearBreachMarker(db: Db): Promise<void> {
  await db.query(`DELETE FROM system_flags WHERE key = $1`, [BREACH_SINCE_KEY]);
}

/** Read-only treasury/PoR state — safe to expose on an admin GET (no sweep, no freeze). */
export interface TreasuryState {
  liabilityE6: bigint; // |ledger TREASURY_USDC| — what the platform owes internally
  hotE6: bigint;
  coldE6: bigint;
  unsweptE6: bigint; // credited deposits still sitting on their deposit addresses
  onchainE6: bigint; // hot + cold + unswept
  pendingE6: bigint; // accepted payouts that will leave the hot wallet
  shortfallE6: bigint; // pending the hot wallet can't cover (operator: top up from cold)
  insuranceE6: bigint; // current insurance-buffer balance (a house claim, not user-owed)
  feeRevenueE6: bigint; // accumulated platform trading-fee earnings (the house's cut, net of insurance moves)
  fundingCollectedE6: bigint; // GROSS funding customers paid in to the house (inbound LP_POOL funding legs only)
  fundingRevenueE6: bigint; // NET funding the house kept (LP_POOL funding inflow − outflow); = collected − paid out
  surplusE6: bigint; // onchain − liabilities: unrecorded house funds the operator can allocate to insurance
  breached: boolean; // proof of reserves failing RIGHT NOW (the frozen flag outlives a breach)
  frozen: string | null; // current freeze reason, if any
}

export interface TreasuryReport extends TreasuryState {
  sweptE6: bigint; // hot -> cold this pass
}

/** Gather the treasury/PoR numbers without acting on them. */
export async function treasuryState(db: Db, chain: TreasuryChain): Promise<TreasuryState> {
  // The reads are mutually independent — gather them concurrently (the chain RPCs dominate).
  const [ledgerBal, [hot, cold], unswept, pendingRes, frozen, insuranceE6, feeRevenueE6, funding] = await Promise.all([
    getOrCreateSystemAccount(db, 'TREASURY_USDC').then((acct) => getBalance(db, acct)),
    Promise.all([chain.hotBalance(), chain.coldBalance()]),
    // Credited-but-unswept deposits still sit on their (ours, HD-derived) deposit addresses —
    // they are custody too, backed by recorded finalized transfers. Prompt sweeps keep this ~0.
    db.query<{ total: string }>(
      `SELECT COALESCE(SUM(usdc_credited_e6), 0)::text AS total FROM deposits
       WHERE asset = 'USDC' AND status = 'credited' AND sweep_sig IS NULL`,
    ),
    // Pending payouts (already debited; will leave the hot wallet) are reserved in the float target.
    db.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount_e6), 0)::text AS total FROM withdrawals
       WHERE status IN ('requested', 'signed', 'broadcast')`,
    ),
    withdrawalsFrozen(db),
    getOrCreateSystemAccount(db, 'INSURANCE_FUND').then((acct) => getBalance(db, acct)),
    getOrCreateSystemAccount(db, 'FEE_REVENUE').then((acct) => getBalance(db, acct)),
    // Funding from FUNDING ledger legs hitting LP_POOL (the funding counterparty): GROSS = inbound
    // (customers paying in, positive legs); NET = gross minus outbound (funding the house paid back out).
    getOrCreateSystemAccount(db, 'LP_POOL').then((acct) =>
      db
        .query<{ net: string; gross: string }>(
          `SELECT COALESCE(SUM(amount_uusdc), 0)::text AS net,
                  COALESCE(SUM(CASE WHEN amount_uusdc > 0 THEN amount_uusdc ELSE 0 END), 0)::text AS gross
           FROM ledger_entries WHERE account_id = $1 AND reason = 'FUNDING'`,
          [acct],
        )
        .then((r) => ({ net: BigInt(r.rows[0].net), gross: BigInt(r.rows[0].gross) })),
    ),
  ]);

  const liabilityE6 = ledgerBal < 0n ? -ledgerBal : 0n;
  const unsweptE6 = BigInt(unswept.rows[0].total);
  const onchainE6 = hot + cold + unsweptE6;
  const pendingE6 = BigInt(pendingRes.rows[0].total);
  return {
    liabilityE6,
    hotE6: hot,
    coldE6: cold,
    unsweptE6,
    onchainE6,
    pendingE6,
    shortfallE6: pendingE6 > hot ? pendingE6 - hot : 0n,
    insuranceE6,
    feeRevenueE6,
    fundingCollectedE6: funding.gross,
    fundingRevenueE6: funding.net,
    surplusE6: onchainE6 - liabilityE6,
    breached: onchainE6 < liabilityE6,
    frozen,
  };
}

/** Total customer USDC in the system: free collateral + margin locked in open positions. Aggregated
 *  across all users for the operator dashboard (separate from `liabilityE6`, which also includes the
 *  LP pool, insurance, fees and PnL clearing — i.e. house claims, not just what customers hold). */
export async function customerFunds(db: Db): Promise<{ freeE6: bigint; lockedE6: bigint }> {
  const r = await db.query<{ type: string; total: string }>(
    `SELECT a.type, COALESCE(SUM(b.amount_uusdc), 0)::text AS total
       FROM accounts a LEFT JOIN balances b ON b.account_id = a.id
      WHERE a.type IN ('USER_COLLATERAL', 'USER_POSITION_MARGIN')
      GROUP BY a.type`,
  );
  let freeE6 = 0n;
  let lockedE6 = 0n;
  for (const row of r.rows) {
    if (row.type === 'USER_COLLATERAL') freeE6 = BigInt(row.total);
    else if (row.type === 'USER_POSITION_MARGIN') lockedE6 = BigInt(row.total);
  }
  return { freeE6, lockedE6 };
}

/** One treasury pass: proof-of-reserves (auto-freeze on a MATERIAL or PERSISTENT breach), then hot-float management. */
export async function treasuryPass(db: Db, chain: TreasuryChain, log?: CustodyLog, now: () => number = Date.now): Promise<TreasuryReport> {
  const s = await treasuryState(db, chain);

  // --- proof of reserves -------------------------------------------------------------------
  if (s.breached) {
    const reason =
      `proof-of-reserves breach: on-chain custody ${s.onchainE6} uUSDC ` +
      `(hot ${s.hotE6} + cold ${s.coldE6} + unswept ${s.unsweptE6}) < liabilities ${s.liabilityE6} uUSDC`;
    // A MATERIAL breach (deficit > treasuryBreachMaterialBps of liabilities) is a real shortfall → freeze NOW.
    // A small breach is most likely a transient measurement blip (e.g. RPC lag at a deposit-sweep hand-off, where a
    // just-swept deposit dropped out of `unswept` before the hot read caught up) → only freeze if it PERSISTS past
    // the grace window, so a momentary blip that clears by the next pass never trips a global freeze.
    const deficit = s.liabilityE6 - s.onchainE6; // > 0 here (breached)
    const material = s.liabilityE6 > 0n && deficit * 10000n > s.liabilityE6 * BigInt(config.treasuryBreachMaterialBps);
    const t = now();
    const marker = await getBreachMarker(db);
    const start = marker?.start ?? t;
    await setBreachMarker(db, { start, solventPasses: 0 }); // a breached pass zeroes the solvent counter — a brief solvent flicker can't reset the episode
    if (material || t - start >= config.treasuryBreachGraceMs) {
      await freezeWithdrawals(db, reason);
      log?.error({ onchainE6: s.onchainE6.toString(), liabilityE6: s.liabilityE6.toString(), material }, reason);
    } else {
      log?.error({ deficitE6: deficit.toString(), sinceMs: start }, `${reason} — within grace, not freezing yet`);
    }
  } else {
    // solvent: end the breach episode only after enough CONSECUTIVE solvent passes, so a flickering sub-material
    // breach can't dodge the freeze by intermittently reading solvent. (A set freeze flag still needs a MANUAL unfreeze.)
    const marker = await getBreachMarker(db);
    if (marker) {
      const solventPasses = marker.solventPasses + 1;
      if (solventPasses >= config.treasuryBreachClearPasses) await clearBreachMarker(db);
      else await setBreachMarker(db, { start: marker.start, solventPasses });
    }
  }

  // --- hot-float management (band: fill to cap via deposits, drain to floor) ----------------
  const limits = getLimits();
  const cap = usdc(limits.hotWalletMaxUsd);
  const floor = (cap * BigInt(limits.hotWalletFloorPct)) / 100n;
  // Drain down to the floor, but never below what queued withdrawals need.
  const reserve = s.pendingE6 > floor ? s.pendingE6 : floor;
  // Band trigger: only rebalance once hot reaches the cap, then drain the excess above `reserve` to
  // cold. The minSweep gate below drops a non-positive amount (e.g. when pending already exceeds hot).
  const excess = s.hotE6 >= cap ? s.hotE6 - reserve : 0n;
  const sweptE6 = excess >= usdc(limits.minSweepUsd) ? excess : 0n;
  if (sweptE6 > 0n) await chain.sweepToCold(sweptE6);

  if (s.shortfallE6 > 0n) {
    log?.error(
      { shortfallE6: s.shortfallE6.toString(), hotE6: s.hotE6.toString(), pendingE6: s.pendingE6.toString() },
      'hot wallet cannot cover pending withdrawals — top up from the cold treasury',
    );
  }

  return { ...s, sweptE6 };
}
