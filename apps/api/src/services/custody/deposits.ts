import { randomUUID } from 'node:crypto';
import type { Keypair } from '@solana/web3.js';
import { getLimits } from './limits.ts';
import type { Db } from '../../db/client.ts';
import { getOrCreateSystemAccount, getOrCreateUserAccount, postTxn } from '../ledger.ts';
import { usdc } from '../../money.ts';
import { deriveDepositKeypair } from './wallet.ts';

/**
 * Deposit pipeline (custody P1 + P1.5):
 *
 *   USDC:  detect (finalized) -> credit the ledger -> sweep to treasury (async, self-healing)
 *   SOL:   detect (finalized) -> Jupiter-swap to USDC, in place -> the swap's USDC proceeds land
 *          on this same deposit address and are detected + credited as their own USDC row
 *          (sig = the swap tx) on a later pass.
 *
 * SOL rows NEVER credit directly — only USDC rows do. That single rule makes the swap crash-safe
 * (an unrecorded swap's proceeds still credit via the USDC path) and double-credits structurally
 * impossible (every credited sig is a unique USDC delta, once).
 *
 * Credit-first: once an inbound transfer is FINALIZED the funds already sit in our custody
 * (the deposit address is ours, HD-derived), so the user is credited immediately — sweep
 * health never delays or strands a credit. Both the sweep and the SOL swap are FULL-BALANCE
 * moves (naturally idempotent: they retry until the address is empty).
 *
 * Crediting is idempotent (UNIQUE(onchain_sig, asset) + a status guard under FOR UPDATE) and
 * ALWAYS for the full received amount — the play-money faucet clamp (creditCapped's $1M cap)
 * must never apply to real money: a clamped real deposit would be USDC received on-chain but
 * not credited.
 *
 * Proof-of-reserves note: with credit-before-sweep, on-chain custody = treasury + unswept
 * deposit-address balances; prompt sweeps keep the second term ~0 and the P3 chain
 * reconciler must count both.
 */

export interface InboundUsdc {
  sig: string;
  amountE6: bigint;
}

export interface InboundSol {
  sig: string;
  lamports: bigint;
}

/** One scan of an address's inbound history since the caller's high-water mark. */
export interface InboundPage<T> {
  /** New finalized inbound transfers, oldest first. */
  transfers: T[];
  /** The new high-water signature to persist — the caller's `until` unchanged when nothing new
   *  was seen OR the impl couldn't complete pagination (never advances past unfetched history). */
  highWater: string | null;
}

export interface SweepResult {
  sig: string;
  amountE6: bigint;
}

/** Minimal logger surface the custody workers take (a FastifyBaseLogger satisfies it). */
export type CustodyLog = { error: (obj: unknown, msg: string) => void };

/** Chain-facing surface, injectable for tests (same pattern as oracle.ts's CardFetcher). */
export interface DepositChain {
  /** Whether this network can route SOL->USDC swaps (Jupiter is mainnet-only). When false the
   *  scanner records SOL deposits but parks them — no swap attempts, no retry spam. */
  supportsSolSwaps: boolean;
  /** Finalized inbound USDC transfers to `address` newer than the `until` signature, oldest
   *  first. `knownSigs` lets impls skip per-sig work for already-recorded transfers. */
  inboundUsdc(address: string, knownSigs: Set<string>, until: string | null): Promise<InboundPage<InboundUsdc>>;
  /** Finalized inbound native-SOL transfers to `address` newer than `until`, oldest first. */
  inboundSol(address: string, knownSigs: Set<string>, until: string | null): Promise<InboundPage<InboundSol>>;
  /** Finalized native-SOL balance of `address`. */
  solBalance(address: string): Promise<bigint>;
  /** Finalized USDC balance of `address`'s token account. Used to reconcile sweeps: a deposit whose
   *  USDC was already swept to the hot wallet but whose row never got a sweep_sig leaves the address
   *  at 0 yet still counts as unswept (double-counting on-chain custody). */
  usdcBalance(address: string): Promise<bigint>;
  /** Swap `lamports` of the deposit wallet's SOL into USDC in place (Jupiter; the wallet pays its
   *  own fee from the SOL). Proceeds land on the wallet's USDC ATA. Returns the swap signature. */
  swapSolToUsdc(from: Keypair, lamports: bigint): Promise<string>;
  /** Sweep the deposit wallet's ENTIRE USDC balance to the treasury (hot wallet = fee payer).
   *  Naturally idempotent — returns null when the balance is below the impl's sweep threshold
   *  (config.minSweepUsd: don't pay a hot-wallet fee to move dust; small credits accumulate
   *  until a sweep is economic — F5 anti-griefing). */
  sweepAll(from: Keypair): Promise<SweepResult | null>;
  /** Sweep the deposit wallet's residual native SOL into the hot wallet (hot = fee payer), leaving the
   *  rent-exempt floor so the System account stays valid — draining it to 0 is rejected. Its USDC ATA is
   *  a separate account, untouched. Recycles the post-swap fee reserve into hot-wallet gas; returns null
   *  when there's too little above the floor to be worth a tx. */
  sweepSolToHot(from: Keypair): Promise<{ sig: string; lamports: bigint } | null>;
}

const minDepositE6 = (): bigint => usdc(getLimits().minDepositUsd);

/** Kept back from every SOL swap to pay the swap tx fee + the wSOL/USDC-ATA rent (0.005 SOL — a swap
 *  costs ~0.003-0.0045 worst case). The swap TRIGGER is 2x this (deposits >= 0.01 SOL swap); the small
 *  residue left after the swap is then recycled into the hot wallet (sweepSolToHot), so ~$0 SOL stays. */
const SOL_FEE_RESERVE_LAMPORTS = 5_000_000n;

/** Credit a finalized USDC deposit to the user's collateral — full amount, never clamped. Idempotent. */
export async function creditDeposit(db: Db, depositId: string): Promise<string | null> {
  return db.tx(async (q) => {
    const r = await q.query<{ user_id: string; amt: string; status: string; asset: string }>(
      `SELECT user_id, amount_in_raw::text AS amt, status, asset FROM deposits WHERE id = $1 FOR UPDATE`,
      [depositId],
    );
    const d = r.rows[0];
    if (!d || d.status !== 'detected') return null; // unknown, already credited, or terminal dust (idempotent)
    if (d.asset !== 'USDC') return null; // SOL rows never credit — their swapped proceeds do
    const amount = BigInt(d.amt); // USDC raw units == micro-USDC

    const coll = await getOrCreateUserAccount(q, d.user_id, 'USER_COLLATERAL');
    const treasury = await getOrCreateSystemAccount(q, 'TREASURY_USDC');
    const txnId = await postTxn(q, {
      reason: 'DEPOSIT',
      refType: 'deposit',
      refId: depositId,
      entries: [
        { accountId: coll, amount },
        { accountId: treasury, amount: -amount },
      ],
    });
    await q.query(
      `UPDATE deposits SET status = 'credited', usdc_credited_e6 = $2, txn_id = $3, credited_at = now() WHERE id = $1`,
      [depositId, amount.toString(), txnId],
    );
    return txnId;
  });
}

/** Persist an address+asset scan high-water mark. Written AFTER the pass's deposits rows so a
 *  crash between the two re-scans (idempotent) rather than strands. Same-value upserts are
 *  harmless (and keep updated_at = "last scanned"). */
async function saveCursor(db: Db, address: string, asset: string, sig: string | null): Promise<void> {
  if (!sig) return;
  await db.query(
    `INSERT INTO deposit_scan_cursors(address, asset, high_sig) VALUES($1, $2, $3)
     ON CONFLICT(address, asset) DO UPDATE SET high_sig = EXCLUDED.high_sig, updated_at = now()`,
    [address, asset, sig],
  );
}

/**
 * One scan pass over every deposit address:
 *   1. record new finalized inbound USDC + SOL since the persisted high-water sig (idempotent by
 *      (signature, asset); sub-minimum dust is recorded as terminal 'ignored', never re-parsed);
 *   2. swap pending SOL into USDC in place (balance-based, self-healing — see header; skipped
 *      entirely on networks without a swap route, parking the rows instead of retry-spamming);
 *   3. credit every detected USDC row (re-entrant: also resumes rows stranded by a crash);
 *   4. sweep the wallet's USDC to the treasury (retried next pass on failure).
 * Per-address failures are logged and don't stop the pass; everything is safe to re-run.
 */
export async function scanDeposits(
  db: Db,
  chain: DepositChain,
  log?: CustodyLog,
): Promise<{ credited: number }> {
  const addrs = await db.query<{ user_id: string; address: string; derivation_index: number }>(
    `SELECT user_id, address, derivation_index FROM deposit_addresses`,
  );
  let credited = 0;

  for (const a of addrs.rows) {
    try {
      // 1) detect (signatures already recorded for this user are skipped per asset; the persisted
      //    high-water mark bounds how far back the chain impl must page)
      const known = await db.query<{ onchain_sig: string; asset: string }>(
        `SELECT onchain_sig, asset FROM deposits WHERE user_id = $1`,
        [a.user_id],
      );
      const knownUsdc = new Set(known.rows.filter((r) => r.asset === 'USDC').map((r) => r.onchain_sig));
      const knownSol = new Set(known.rows.filter((r) => r.asset === 'SOL').map((r) => r.onchain_sig));
      const curRows = await db.query<{ asset: string; high_sig: string }>(
        `SELECT asset, high_sig FROM deposit_scan_cursors WHERE address = $1`,
        [a.address],
      );
      const cursor = (asset: string) => curRows.rows.find((c) => c.asset === asset)?.high_sig ?? null;

      // the two asset scans hit different chain addresses (token ATA vs wallet) — fetch concurrently
      const [usdcPage, solPage] = await Promise.all([
        chain.inboundUsdc(a.address, knownUsdc, cursor('USDC')),
        chain.inboundSol(a.address, knownSol, cursor('SOL')),
      ]);

      for (const t of usdcPage.transfers) {
        if (knownUsdc.has(t.sig)) continue; // redundant-by-contract (impls filter knownSigs) — belt and suspenders
        // dust below the minimum is terminal 'ignored': uneconomic to credit (anti-dusting), and
        // recording it means it is never fetched or parsed again
        const status = t.amountE6 < minDepositE6() ? 'ignored' : 'detected';
        await db.query(
          `INSERT INTO deposits(id, user_id, onchain_sig, asset, amount_in_raw, status)
           VALUES($1, $2, $3, 'USDC', $4, $5)
           ON CONFLICT(onchain_sig, asset) DO NOTHING`,
          [randomUUID(), a.user_id, t.sig, t.amountE6.toString(), status],
        );
      }
      await saveCursor(db, a.address, 'USDC', usdcPage.highWater);

      for (const t of solPage.transfers) {
        if (knownSol.has(t.sig)) continue;
        await db.query(
          `INSERT INTO deposits(id, user_id, onchain_sig, asset, amount_in_raw, status)
           VALUES($1, $2, $3, 'SOL', $4, 'detected')
           ON CONFLICT(onchain_sig, asset) DO NOTHING`,
          [randomUUID(), a.user_id, t.sig, t.lamports.toString()],
        );
      }
      await saveCursor(db, a.address, 'SOL', solPage.highWater);

      // 2) swap pending SOL -> USDC in place (balance-based). If the balance is at/below the fee
      //    reserve there is nothing meaningfully swappable — either a prior (unrecorded) swap
      //    already converted it (its proceeds credit via the USDC path) or it's true dust — so
      //    the rows are closed out either way. On networks without a swap route the step is
      //    skipped wholesale: rows park at 'detected' and self-heal when a route exists.
      if (chain.supportsSolSwaps) {
        const solPending = await db.query<{ id: string }>(
          `SELECT id FROM deposits WHERE user_id = $1 AND asset = 'SOL' AND status IN ('detected', 'swapping')`,
          [a.user_id],
        );
        if (solPending.rows.length > 0) {
          const balance = await chain.solBalance(a.address);
          if (balance > SOL_FEE_RESERVE_LAMPORTS * 2n) {
            const kp = deriveDepositKeypair(a.derivation_index);
            for (const { id } of solPending.rows) {
              await db.query(`UPDATE deposits SET status = 'swapping' WHERE id = $1`, [id]);
            }
            const sig = await chain.swapSolToUsdc(kp, balance - SOL_FEE_RESERVE_LAMPORTS);
            for (const { id } of solPending.rows) {
              await db.query(`UPDATE deposits SET status = 'swapped', swap_sig = $2 WHERE id = $1`, [id, sig]);
            }
            // Recycle the leftover fee reserve into the hot wallet (where it funds gas) so the deposit
            // address is left at ~$0 SOL. Best-effort: a failure must never abort the USDC credit/sweep
            // below — the residue just stays and is reclaimed on the next swap.
            // Scope: this only recycles the just-swapped address's reserve. Pre-existing residue on
            // addresses that won't swap again, and sub-trigger SOL dust, aren't reached here.
            // TODO: a low-frequency ops sweep over all deposit addresses would close that gap.
            try {
              await chain.sweepSolToHot(kp);
            } catch (e) {
              // Best-effort: never abort the credit/sweep. But DO surface it — a silent swallow is what
              // hid an earlier drain-to-0 failure. The residue stays and is retried on the next swap.
              log?.error(e, 'residual SOL consolidation failed');
            }
          } else {
            for (const { id } of solPending.rows) {
              await db.query(`UPDATE deposits SET status = 'swapped' WHERE id = $1`, [id]);
            }
          }
        }
      }

      // 3) credit (detected USDC rows only; re-entrant — 'ignored' dust never credits)
      const pending = await db.query<{ id: string }>(
        `SELECT id FROM deposits WHERE user_id = $1 AND asset = 'USDC' AND status = 'detected'`,
        [a.user_id],
      );
      for (const p of pending.rows) {
        if (await creditDeposit(db, p.id)) credited++;
      }

      // 4) sweep (idempotent full-balance move; a failure here never blocks credits; the impl
      //    holds sub-threshold balances back — don't pay a fee per dusty deposit, F5)
      const sweep = await chain.sweepAll(deriveDepositKeypair(a.derivation_index));
      if (sweep) {
        await db.query(
          `UPDATE deposits SET sweep_sig = $2 WHERE user_id = $1 AND asset = 'USDC' AND sweep_sig IS NULL`,
          [a.user_id, sweep.sig],
        );
      } else {
        // sweepAll moved nothing. A SOL->USDC deposit's proceeds are swept in the SAME pass as the swap
        // — a pass BEFORE the proceeds row is detected & credited — so that row never receives a
        // sweep_sig and would be double-counted in unsweptE6 against funds already in the hot wallet
        // (same outcome if a sweep finalized on-chain but the process died before this UPDATE). If
        // credited USDC rows are still unswept but the address is genuinely EMPTY, the funds already
        // left: reconcile them. A >0 balance is sub-threshold dust legitimately on the address — leave it.
        const stuck = await db.query(
          `SELECT 1 FROM deposits WHERE user_id = $1 AND asset = 'USDC' AND status = 'credited' AND sweep_sig IS NULL LIMIT 1`,
          [a.user_id],
        );
        if (stuck.rows.length > 0 && (await chain.usdcBalance(a.address)) === 0n) {
          await db.query(
            `UPDATE deposits SET sweep_sig = 'reconciled' WHERE user_id = $1 AND asset = 'USDC' AND status = 'credited' AND sweep_sig IS NULL`,
            [a.user_id],
          );
        }
      }
    } catch (e) {
      log?.error(e, `deposit scan failed for ${a.address} (will retry next pass)`);
    }
  }
  return { credited };
}
