import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  type ConfirmedSignatureInfo,
} from '@solana/web3.js';
import bs58 from 'bs58';
import {
  AccountLayout,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { config } from '../../config.ts';
import { getLimits } from './limits.ts';
import { usdc } from '../../money.ts';
import { swapSolToUsdcViaJupiter } from './jupiter.ts';
import type { DepositChain, InboundSol, InboundUsdc } from './deposits.ts';
import type { WithdrawChain } from './withdrawals.ts';
import type { TreasuryChain } from './treasury.ts';

/**
 * Live Solana implementation of the DepositChain surface (custody P1).
 * Everything reads/settles at `finalized` commitment — deposits are only credited once
 * they can no longer be rolled back.
 *
 * The hot wallet is the fee payer for sweeps: fresh deposit addresses hold no SOL, so the
 * sweep transaction (and the hot wallet's USDC ATA rent, if it doesn't exist yet) is paid by
 * the hot wallet. Deposits consolidate INTO the hot wallet — it funds withdrawals, so incoming
 * deposits self-fund the payout float; the treasury pass later sweeps any hot balance above the
 * cap down to the cold treasury. The hot secret comes from the environment — never the config.
 */

function hotWallet(): Keypair {
  const raw = process.env.HOT_WALLET_SECRET ?? '';
  if (!raw) throw new Error('HOT_WALLET_SECRET is not set (base58 secret key or JSON byte array)');
  try {
    if (raw.trim().startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
    return Keypair.fromSecretKey(bs58.decode(raw.trim()));
  } catch {
    throw new Error('HOT_WALLET_SECRET is not a valid base58 secret key or JSON byte array');
  }
}

/**
 * Finalized USDC balance of `owner`'s ATA; 0 only when the ATA genuinely doesn't exist.
 *
 * A transient RPC failure must NOT read as zero: this feeds the treasury proof-of-reserves check,
 * where a false zero would understate on-chain custody and trip a spurious breach -> withdrawal
 * auto-freeze. getAccountInfo returns null for a missing account (a real zero) but THROWS on an RPC
 * error, so a blip propagates to the caller (the worker logs + retries the pass) instead of freezing.
 */
async function usdcBalance(conn: Connection, mint: PublicKey, owner: PublicKey, offCurve = false): Promise<bigint> {
  const ata = getAssociatedTokenAddressSync(mint, owner, offCurve);
  const info = await conn.getAccountInfo(ata, 'finalized');
  return info ? AccountLayout.decode(info.data).amount : 0n;
}

/**
 * Full signature history of `address` since the `until` signature (exclusive), newest first, by
 * paging getSignaturesForAddress backwards — plus the new `highWater` cursor for the caller to
 * persist. RPC eviction can't strand anything: the cursor only ever advances over history that
 * was actually fetched, so a backlog — or adversarial dust-spam — larger than one page is picked
 * up by pagination, and a backlog larger than MAX_PAGES (pathological) is retried from the same
 * cursor next pass.
 */
const SIG_PAGE_LIMIT = 1000; // the RPC maximum
const SIG_MAX_PAGES = 10;
async function signaturesSince(
  conn: Connection,
  addr: PublicKey,
  until: string | null,
): Promise<{ sigs: ConfirmedSignatureInfo[]; highWater: string | null }> {
  const sigs: ConfirmedSignatureInfo[] = [];
  let before: string | undefined;
  for (let page = 0; page < SIG_MAX_PAGES; page++) {
    const batch = await conn.getSignaturesForAddress(
      addr,
      { limit: SIG_PAGE_LIMIT, before, until: until ?? undefined },
      'finalized',
    );
    sigs.push(...batch);
    // pagination complete: the cursor may advance to the newest sig seen (or stay when none)
    if (batch.length < SIG_PAGE_LIMIT) return { sigs, highWater: sigs[0]?.signature ?? until };
    before = batch[batch.length - 1].signature;
  }
  return { sigs, highWater: until }; // capped: never advance past unfetched history
}

// Native SOL left on the deposit address when consolidating: above the ~0.00089 rent-exempt minimum (a
// System account can't be drained below rent-exempt, and draining to exactly 0 is rejected — that's the
// bug this guards), so the account stays valid + reusable. (Its USDC ATA's own ~0.002 SOL rent is
// irreducible regardless.)
const SOL_KEEP_LAMPORTS = 1_000_000n; // 0.001 SOL — the rent floor we leave behind
// Don't pay a tx fee to move less than this above the keep floor (avoids churning on tiny residue).
const SOL_SWEEP_MIN_LAMPORTS = 1_000_000n; // 0.001 SOL

export function solanaDepositChain(): DepositChain {
  const conn = new Connection(config.solanaRpcUrl, 'finalized');
  const usdcMint = new PublicKey(config.usdcMint);

  return {
    supportsSolSwaps: config.solSwapsEnabled,

    async inboundUsdc(address: string, knownSigs: Set<string>, until: string | null) {
      const ata = getAssociatedTokenAddressSync(usdcMint, new PublicKey(address));
      const { sigs, highWater } = await signaturesSince(conn, ata, until);
      const transfers: InboundUsdc[] = [];
      for (const s of [...sigs].reverse()) {
        // oldest first; skip failures and anything already recorded
        if (s.err || knownSigs.has(s.signature)) continue;
        const tx = await conn.getParsedTransaction(s.signature, {
          commitment: 'finalized',
          maxSupportedTransactionVersion: 0,
        });
        // A finalized sig must be fetchable; a transient RPC miss aborts the pass (cursor doesn't
        // advance, next pass retries) rather than silently skipping — a skip would strand it.
        if (!tx?.meta) throw new Error(`finalized tx ${s.signature} not fetchable (will retry)`);
        // inbound amount = the owner's USDC balance delta in this tx (owner-matched, mint-matched)
        const post = tx.meta.postTokenBalances?.find((b) => b.mint === config.usdcMint && b.owner === address);
        const pre = tx.meta.preTokenBalances?.find((b) => b.mint === config.usdcMint && b.owner === address);
        const delta = BigInt(post?.uiTokenAmount.amount ?? '0') - BigInt(pre?.uiTokenAmount.amount ?? '0');
        if (delta > 0n) transfers.push({ sig: s.signature, amountE6: delta });
      }
      return { transfers, highWater };
    },

    async inboundSol(address: string, knownSigs: Set<string>, until: string | null) {
      const pk = new PublicKey(address);
      const { sigs, highWater } = await signaturesSince(conn, pk, until);
      const transfers: InboundSol[] = [];
      for (const s of [...sigs].reverse()) {
        // oldest first; skip failures + known sigs. The wallet's own swaps/sweeps show up here
        // too but with a non-positive lamport delta, so the > 0 filter drops them.
        if (s.err || knownSigs.has(s.signature)) continue;
        const tx = await conn.getParsedTransaction(s.signature, {
          commitment: 'finalized',
          maxSupportedTransactionVersion: 0,
        });
        // same retry-not-skip rule as inboundUsdc — a skip under an advancing cursor would strand
        if (!tx?.meta) throw new Error(`finalized tx ${s.signature} not fetchable (will retry)`);
        const idx = tx.transaction.message.accountKeys.findIndex((k) => k.pubkey.toBase58() === address);
        if (idx < 0) continue;
        const delta = BigInt(tx.meta.postBalances[idx]) - BigInt(tx.meta.preBalances[idx]);
        if (delta > 0n) transfers.push({ sig: s.signature, lamports: delta });
      }
      return { transfers, highWater };
    },

    async solBalance(address: string): Promise<bigint> {
      return BigInt(await conn.getBalance(new PublicKey(address), 'finalized'));
    },

    async usdcBalance(address: string): Promise<bigint> {
      return usdcBalance(conn, usdcMint, new PublicKey(address));
    },

    async swapSolToUsdc(from: Keypair, lamports: bigint): Promise<string> {
      return swapSolToUsdcViaJupiter(conn, from, lamports);
    },

    async sweepAll(from: Keypair) {
      const balance = await usdcBalance(conn, usdcMint, from.publicKey);
      if (balance <= 0n || balance < usdc(getLimits().minSweepUsd)) return null; // sub-threshold balances accumulate (F5)
      const fromAta = getAssociatedTokenAddressSync(usdcMint, from.publicKey);

      // Deposits consolidate into the HOT wallet (it funds withdrawals); the treasury pass sweeps
      // any hot balance above the cap down to cold. The hot wallet is fee payer AND destination
      // owner, funding its own ATA rent if the account doesn't exist yet.
      const hot = hotWallet();
      const toAta = getAssociatedTokenAddressSync(usdcMint, hot.publicKey);
      const tx = new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(hot.publicKey, toAta, hot.publicKey, usdcMint),
        createTransferInstruction(fromAta, toAta, from.publicKey, balance),
      );
      tx.feePayer = hot.publicKey;
      const sig = await sendAndConfirmTransaction(conn, tx, [hot, from], { commitment: 'finalized' });
      return { sig, amountE6: balance };
    },

    async sweepSolToHot(from: Keypair) {
      const balance = BigInt(await conn.getBalance(from.publicKey, 'finalized'));
      const sweepable = balance - SOL_KEEP_LAMPORTS;
      if (sweepable < SOL_SWEEP_MIN_LAMPORTS) return null; // not worth a tx fee
      const hot = hotWallet();
      // Hot wallet pays the fee. We move everything ABOVE SOL_KEEP_LAMPORTS and leave that floor so the
      // System account stays rent-exempt + valid (transferring the whole balance to 0 is rejected). The
      // USDC ATA is a separate account, untouched — the swapped USDC stays until the USDC sweep moves it.
      const tx = new Transaction().add(
        SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: hot.publicKey, lamports: sweepable }),
      );
      tx.feePayer = hot.publicKey;
      const sig = await sendAndConfirmTransaction(conn, tx, [hot, from], { commitment: 'finalized' });
      return { sig, lamports: sweepable };
    },
  };
}

/**
 * Live Solana implementation of the WithdrawChain surface (custody P2). Payouts go from the
 * hot wallet's USDC ATA to the destination (hot float topped up from the treasury — custody P3);
 * the hot wallet pays the network fee and the destination ATA's rent if it doesn't exist yet.
 */
export function solanaWithdrawChain(): WithdrawChain {
  const conn = new Connection(config.solanaRpcUrl, 'finalized');
  const usdcMint = new PublicKey(config.usdcMint);

  return {
    async signUsdcTransfer(dest: string, amountE6: bigint) {
      const hot = hotWallet();
      const destOwner = new PublicKey(dest);
      const fromAta = getAssociatedTokenAddressSync(usdcMint, hot.publicKey);
      // allowOwnerOffCurve: the user may withdraw to a program-owned address (e.g. a multisig
      // vault) — the step-up signature binds the exact destination either way.
      const toAta = getAssociatedTokenAddressSync(usdcMint, destOwner, true);
      const tx = new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(hot.publicKey, toAta, destOwner, usdcMint),
        createTransferInstruction(fromAta, toAta, hot.publicKey, amountE6),
      );
      tx.feePayer = hot.publicKey;
      tx.recentBlockhash = (await conn.getLatestBlockhash('finalized')).blockhash;
      tx.sign(hot); // local signing only; the tx signature is now fixed
      return { signedTxB64: tx.serialize().toString('base64'), sig: bs58.encode(tx.signature!) };
    },

    async broadcast(signedTxB64: string) {
      const raw = Buffer.from(signedTxB64, 'base64');
      const sig = await conn.sendRawTransaction(raw);
      const bh = await conn.getLatestBlockhash('finalized');
      await conn.confirmTransaction(
        { signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight },
        'finalized',
      );
    },

    async sigStatus(sig: string, signedTxB64: string) {
      const st = (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0];
      if (st?.confirmationStatus === 'finalized') return 'confirmed';
      // Not finalized: the tx can still land only while its blockhash is valid.
      const tx = Transaction.from(Buffer.from(signedTxB64, 'base64'));
      const valid = (await conn.isBlockhashValid(tx.recentBlockhash!, { commitment: 'finalized' })).value;
      return st || valid ? 'pending' : 'dead';
    },
  };
}

/**
 * Live Solana implementation of the TreasuryChain surface (custody P3). The cold treasury is a
 * multisig (Squads) the server cannot sign for — only hot -> cold moves are automated here;
 * cold -> hot top-ups are a manual multisig operation flagged by the treasury worker.
 */
export function solanaTreasuryChain(): TreasuryChain {
  const conn = new Connection(config.solanaRpcUrl, 'finalized');
  const usdcMint = new PublicKey(config.usdcMint);
  const treasury = new PublicKey(config.treasuryPubkey);

  return {
    hotBalance: () => usdcBalance(conn, usdcMint, hotWallet().publicKey),
    coldBalance: () => usdcBalance(conn, usdcMint, treasury, true), // the treasury may be a Squads multisig PDA

    async sweepToCold(amountE6: bigint) {
      const hot = hotWallet();
      const fromAta = getAssociatedTokenAddressSync(usdcMint, hot.publicKey);
      const toAta = getAssociatedTokenAddressSync(usdcMint, treasury, true);
      const tx = new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(hot.publicKey, toAta, treasury, usdcMint),
        createTransferInstruction(fromAta, toAta, hot.publicKey, amountE6),
      );
      tx.feePayer = hot.publicKey;
      return sendAndConfirmTransaction(conn, tx, [hot], { commitment: 'finalized' });
    },
  };
}
