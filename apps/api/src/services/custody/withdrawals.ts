import { randomUUID } from 'node:crypto';
import { getLimits } from './limits.ts';
import { HttpError } from '../../errors.ts';
import type { Db, Queryer } from '../../db/client.ts';
import { getOrCreateSystemAccount, getOrCreateUserAccount, postTxn } from '../ledger.ts';
import { isValidPubkey, verifyWithdrawalStepUp } from '../auth.ts';
import { usdc } from '../../money.ts';
import type { CustodyLog } from './deposits.ts';
import { withdrawalsFrozen } from './treasury.ts';
import { getWithdrawalAutoProcess } from '../withdrawal-config.ts';
import { creditState, floorWithdrawable, needsFirstWithdrawalReview } from '../signup-credit.ts';

/**
 * Withdrawal pipeline (custody P2). Lifecycle: requested -> signed -> broadcast -> confirmed,
 * with failed/reversed as the off-ramps. Three rules make it safe:
 *
 *   1. VALIDATE + DEBIT ATOMICALLY. `requestWithdrawal` runs in one db.tx with the collateral
 *      balance row locked FOR UPDATE (same discipline as the engine), so a concurrent trade or
 *      second withdrawal can't race the balance check. The ledger debit (-USER_COLLATERAL,
 *      +TREASURY_USDC) posts BEFORE anything touches the chain — funds are locked from the
 *      moment the request is accepted.
 *
 *   2. SIGN ONCE, PERSIST, THEN BROADCAST. `processWithdrawal` signs under the row lock and
 *      persists signed_tx + its signature in the same transaction, so there is exactly one
 *      signed payload per withdrawal. A crash after signing can only ever RE-broadcast that
 *      same tx (same sig — idempotent on-chain); a second payout is structurally impossible.
 *      Re-signing happens only when the persisted tx is provably dead (sig absent on-chain AND
 *      its blockhash expired, so the old tx can never land).
 *
 *   3. REVERSE ONLY WHAT PROVABLY DIDN'T PAY. `reverseWithdrawal` re-credits the user only for
 *      'requested' rows (nothing signed) or rows whose signed tx is provably dead.
 *
 * P2 ships with MANUAL approval: 'requested' rows sit debited until an operator runs
 * `processWithdrawal` (or WITHDRAWAL_AUTO_PROCESS turns on the loop — custody P3). Boot
 * recovery of in-flight rows always runs (crash safety).
 */

/** Chain-facing surface, injectable for tests (same pattern as DepositChain). */
export interface WithdrawChain {
  /** Build + sign a treasury->dest USDC transfer. Local signing only — nothing is broadcast.
   *  The tx signature is known at signing time; both are persisted before any broadcast. */
  signUsdcTransfer(dest: string, amountE6: bigint): Promise<{ signedTxB64: string; sig: string }>;
  /** Broadcast a previously signed tx and wait for finalized confirmation. Re-broadcasting the
   *  same payload is idempotent on Solana (same signature). */
  broadcast(signedTxB64: string): Promise<void>;
  /** Where a signed tx stands on-chain: finalized, still landable, or provably dead
   *  (signature absent AND the tx's blockhash expired — it can never land). */
  sigStatus(sig: string, signedTxB64: string): Promise<'confirmed' | 'pending' | 'dead'>;
}

export interface WithdrawalRow {
  id: string;
  status: string;
  amountE6: bigint;
  dest: string;
  duplicate?: boolean;
}

export interface WithdrawInput {
  amountE6: bigint;
  dest: string;
  idempotencyKey: string;
  message: string;
  signature: string;
}

async function getWithdrawal(q: Queryer, id: string, lock = false) {
  const r = await q.query<{
    user_id: string; dest_address: string; amount_e6: string; status: string;
    signed_tx: string | null; onchain_sig: string | null;
  }>(
    `SELECT user_id, dest_address, amount_e6::text AS amount_e6, status, signed_tx, onchain_sig
     FROM withdrawals WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
    [id],
  );
  return r.rows[0];
}

/** The ONLY place a withdrawal is ever signed. Must run under the caller's row lock so two
 *  processors can't produce two broadcastable payloads for one withdrawal. */
async function signAndPersist(
  q: Queryer,
  chain: WithdrawChain,
  id: string,
  dest: string,
  amountE6: bigint,
  reason?: string,
): Promise<string> {
  const s = await chain.signUsdcTransfer(dest, amountE6);
  await q.query(
    `UPDATE withdrawals SET status = 'signed', signed_tx = $2, onchain_sig = $3, signed_at = now(),
       reason = COALESCE($4, reason) WHERE id = $1`,
    [id, s.signedTxB64, s.sig, reason ?? null],
  );
  return s.signedTxB64;
}

const markConfirmed = (q: Queryer, id: string) =>
  q.query(`UPDATE withdrawals SET status = 'confirmed', confirmed_at = now() WHERE id = $1`, [id]);

/**
 * Accept a withdrawal: verify the step-up signature, validate limits, debit the ledger — all in
 * one transaction. An idempotency-key replay returns the existing row (no second debit) BEFORE
 * step-up verification, so a network-retry of an accepted request doesn't fail on its
 * already-claimed nonce.
 */
export async function requestWithdrawal(
  db: Db,
  userId: string,
  pubkey: string,
  input: WithdrawInput,
): Promise<WithdrawalRow> {
  // Zero-IO checks first — a malformed request never opens a transaction.
  if (!isValidPubkey(input.dest)) throw new HttpError(400, 'invalid destination address');
  const minWithdrawalUsd = getLimits().minWithdrawalUsd;
  if (input.amountE6 < usdc(minWithdrawalUsd)) {
    throw new HttpError(400, `minimum withdrawal is ${minWithdrawalUsd} USDC`);
  }

  // Auto-freeze gate (custody P3): a proof-of-reserves breach halts new withdrawals app-wide.
  const frozen = await withdrawalsFrozen(db);
  if (frozen) throw new HttpError(503, `withdrawals are temporarily frozen: ${frozen}`);

  return db.tx(async (q) => {
    // Idempotency anchor (mirrors the engine's order anchor): a duplicate — racing or retried —
    // inserts nothing and replays the winner instead of debiting twice.
    const id = randomUUID();
    const anchor = await q.query<{ id: string }>(
      `INSERT INTO withdrawals(id, user_id, dest_address, amount_e6, status, idempotency_key)
       VALUES($1, $2, $3, $4, 'requested', $5)
       ON CONFLICT(user_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [id, userId, input.dest, input.amountE6.toString(), input.idempotencyKey],
    );
    if (!anchor.rows[0]) {
      const winner = await q.query<{ id: string; status: string }>(
        `SELECT id, status FROM withdrawals WHERE user_id = $1 AND idempotency_key = $2`,
        [userId, input.idempotencyKey],
      );
      return { id: winner.rows[0].id, status: winner.rows[0].status, amountE6: input.amountE6, dest: input.dest, duplicate: true };
    }

    // Step-up: a fresh wallet signature over the EXACT (amount, dest). Claimed in this tx, so a
    // request rejected below rolls the claim back and the user can retry with the same message.
    await verifyWithdrawalStepUp(q, {
      pubkey,
      amountE6: input.amountE6,
      dest: input.dest,
      message: input.message,
      signature: input.signature,
    });

    // Per-user daily velocity cap (the anchor row above is included in the SUM).
    const day = await q.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount_e6), 0)::text AS total FROM withdrawals
       WHERE user_id = $1 AND requested_at > now() - interval '24 hours'
         AND status NOT IN ('failed', 'reversed')`,
      [userId],
    );
    const dailyCapUsd = getLimits().withdrawalDailyCapUsd;
    if (BigInt(day.rows[0].total) > usdc(dailyCapUsd)) {
      throw new HttpError(429, `daily withdrawal cap is ${dailyCapUsd} USDC`);
    }

    // Lock the collateral row so a concurrent trade/withdrawal can't race the balance check
    // (same discipline as the engine; the locking read doubles as the balance read).
    const coll = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
    const lock = await q.query<{ amount_uusdc: string }>(
      `SELECT amount_uusdc FROM balances WHERE account_id = $1 FOR UPDATE`,
      [coll],
    );
    const lockedBalance = lock.rows[0] ? BigInt(lock.rows[0].amount_uusdc) : 0n;
    // Signup-credit floor (docs/signup-credit-spec.md §2.2): for a normal account this == lockedBalance; for a
    // credit account it excludes the non-withdrawable grant principal (and winnings, pre-wagering). The single
    // withdrawal cap; the locked balance read above keeps the check-then-debit atomic.
    const available = floorWithdrawable(lockedBalance, await creditState(q, userId));
    if (available < input.amountE6) throw new HttpError(400, 'insufficient balance');

    const treasury = await getOrCreateSystemAccount(q, 'TREASURY_USDC');
    const txnId = await postTxn(q, {
      reason: 'WITHDRAWAL',
      refType: 'withdrawal',
      refId: id,
      entries: [
        { accountId: coll, amount: -input.amountE6 },
        { accountId: treasury, amount: input.amountE6 },
      ],
    });
    await q.query(`UPDATE withdrawals SET txn_id = $2 WHERE id = $1`, [id, txnId]);

    return { id, status: 'requested', amountE6: input.amountE6, dest: input.dest };
  });
}

export interface WithdrawalListRow {
  id: string;
  pubkey: string;
  dest_address: string;
  amount_e6: string;
  status: string;
  reason: string | null;
  requested_at: string;
  onchain_sig: string | null;
}

/** The operator's withdrawal queue view: rows in `status`, newest first, with the owner pubkey. */
export async function listWithdrawals(db: Queryer, status: string, limit = 100): Promise<WithdrawalListRow[]> {
  const n = Math.min(Math.max(limit, 1), 200);
  const r = await db.query<WithdrawalListRow>(
    `SELECT w.id, u.solana_pubkey AS pubkey, w.dest_address, w.amount_e6::text AS amount_e6,
            w.status, w.reason, w.requested_at, w.onchain_sig
     FROM withdrawals w JOIN users u ON u.id = w.user_id
     WHERE w.status = $1 ORDER BY w.requested_at DESC LIMIT $2`,
    [status, n],
  );
  return r.rows;
}

/**
 * Sign + broadcast one accepted withdrawal (operator action in P2; the auto loop in P3).
 * Signing happens under the row lock and persists signed_tx + sig in the same transaction —
 * exactly one signed payload can ever exist for a withdrawal.
 */
export async function processWithdrawal(db: Db, chain: WithdrawChain, id: string): Promise<{ status: string }> {
  const signedTxB64 = await db.tx(async (q) => {
    const w = await getWithdrawal(q, id, true);
    if (!w) throw new HttpError(404, 'withdrawal not found');
    if (w.status === 'requested') {
      // The freeze halts NEW payouts only — already-signed rows below still resume, since their
      // debit is final and re-broadcasting a signed tx can't be prevented anyway.
      const frozen = await withdrawalsFrozen(q);
      if (frozen) throw new HttpError(503, `withdrawals are temporarily frozen: ${frozen}`);
      return signAndPersist(q, chain, id, w.dest_address, BigInt(w.amount_e6));
    }
    if (w.status === 'signed' || w.status === 'broadcast') return w.signed_tx!; // resume
    throw new HttpError(409, `withdrawal is ${w.status}`);
  });

  // Broadcast outside the row lock. 'broadcast' is set first so a crash mid-flight leaves a row
  // the boot recovery resolves by checking the chain for the persisted sig.
  await db.query(`UPDATE withdrawals SET status = 'broadcast' WHERE id = $1`, [id]);
  await chain.broadcast(signedTxB64);
  await markConfirmed(db, id);
  return { status: 'confirmed' };
}

/** The WITHDRAWAL_AUTO_PROCESS loop: process accepted withdrawals up to the auto-approve cap.
 *  Larger rows (and everything while frozen) sit debited until an operator runs
 *  processWithdrawal explicitly — the P3 velocity guard on automated payouts. */
/** Whether a freshly-requested withdrawal of `amountE6` will be auto-processed by the worker: the admin
 *  toggle is ON, it's within the auto-approve cap, and withdrawals aren't frozen (a PoR breach pauses even
 *  auto-approval). Drives the client's request-confirmation message. */
export async function willAutoApprove(db: Db, amountE6: bigint, userId?: string): Promise<boolean> {
  // A credit-origin first withdrawal is held for manual review (signup-credit §3d) — mirror processAllRequested's
  // skip here so the client is told "follows approval", not "on its way".
  if (userId && (await needsFirstWithdrawalReview(db, userId))) return false;
  return (
    getWithdrawalAutoProcess() &&
    amountE6 <= usdc(getLimits().withdrawalAutoApproveMaxUsd) &&
    !(await withdrawalsFrozen(db))
  );
}

export async function processAllRequested(
  db: Db,
  chain: WithdrawChain,
  log?: CustodyLog,
): Promise<{ confirmed: number }> {
  if (await withdrawalsFrozen(db)) return { confirmed: 0 };
  const r = await db.query<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM withdrawals WHERE status = 'requested' AND amount_e6 <= $1 ORDER BY requested_at`,
    [usdc(getLimits().withdrawalAutoApproveMaxUsd).toString()],
  );
  let confirmed = 0;
  for (const { id, user_id } of r.rows) {
    // Hold a credit-origin account's FIRST withdrawal for manual review (signup-credit spec §3d) — never auto-pay it.
    if (await needsFirstWithdrawalReview(db, user_id)) continue;
    try {
      await processWithdrawal(db, chain, id);
      confirmed++;
    } catch (e) {
      log?.error(e, `withdrawal ${id} failed to process (will retry)`);
    }
  }
  return { confirmed };
}

/**
 * Boot recovery for in-flight ('signed'/'broadcast') withdrawals — runs whenever the process
 * starts. Checks the chain for each persisted sig:
 *   confirmed -> mark confirmed;  pending -> re-broadcast the SAME tx (idempotent);
 *   dead (provably can never land) -> re-sign once and broadcast the replacement.
 */
export async function recoverInFlight(
  db: Db,
  chain: WithdrawChain,
  log?: CustodyLog,
): Promise<{ recovered: number }> {
  const rows = await db.query<{ id: string; dest_address: string; amount_e6: string; signed_tx: string; onchain_sig: string }>(
    `SELECT id, dest_address, amount_e6::text AS amount_e6, signed_tx, onchain_sig
     FROM withdrawals WHERE status IN ('signed', 'broadcast')`,
  );
  let recovered = 0;
  for (const w of rows.rows) {
    try {
      const status = await chain.sigStatus(w.onchain_sig, w.signed_tx);
      if (status === 'dead') {
        // The persisted tx can never land — replace it under the row lock (status re-checked so a
        // concurrent processor can't double-replace) and fall through to broadcast.
        await db.tx(async (q) => {
          const cur = await getWithdrawal(q, w.id, true);
          if (cur.status !== 'signed' && cur.status !== 'broadcast') return;
          await signAndPersist(q, chain, w.id, w.dest_address, BigInt(w.amount_e6), 'replaced: original tx expired un-broadcast');
        });
      }
      if (status !== 'confirmed') await processWithdrawal(db, chain, w.id);
      else await markConfirmed(db, w.id);
      recovered++;
    } catch (e) {
      log?.error(e, `withdrawal ${w.id} recovery failed (will retry on next boot)`);
    }
  }
  return { recovered };
}

/**
 * Re-credit a withdrawal that provably never paid out (operator action): 'requested' rows
 * unconditionally; 'signed'/'broadcast' rows only when the signed tx is dead on-chain.
 */
export async function reverseWithdrawal(db: Db, chain: WithdrawChain, id: string, reason: string): Promise<void> {
  // Chain check first (outside the tx — RPC under a row lock is worse than a benign re-check race;
  // the status re-read under FOR UPDATE below is what guards correctness).
  const w = await getWithdrawal(db, id);
  if (!w) throw new HttpError(404, 'withdrawal not found');
  if (w.status === 'signed' || w.status === 'broadcast') {
    const status = await chain.sigStatus(w.onchain_sig!, w.signed_tx!);
    if (status !== 'dead') throw new HttpError(409, `signed tx is ${status} on-chain — cannot reverse`);
  } else if (w.status !== 'requested') {
    throw new HttpError(409, `withdrawal is ${w.status}`);
  }

  await db.tx(async (q) => {
    const cur = await getWithdrawal(q, id, true);
    if (!['requested', 'signed', 'broadcast'].includes(cur.status)) {
      throw new HttpError(409, `withdrawal is ${cur.status}`);
    }
    const coll = await getOrCreateUserAccount(q, cur.user_id, 'USER_COLLATERAL');
    const treasury = await getOrCreateSystemAccount(q, 'TREASURY_USDC');
    await postTxn(q, {
      reason: 'WITHDRAWAL_REVERSAL',
      refType: 'withdrawal',
      refId: id,
      entries: [
        { accountId: coll, amount: BigInt(cur.amount_e6) },
        { accountId: treasury, amount: -BigInt(cur.amount_e6) },
      ],
    });
    await q.query(`UPDATE withdrawals SET status = 'reversed', reason = $2 WHERE id = $1`, [id, reason]);
  });
}
