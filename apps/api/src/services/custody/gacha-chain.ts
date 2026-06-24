import { Connection, Keypair, PublicKey, SystemProgram, Transaction, VersionedTransaction } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, createTransferInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { config } from '../../config.ts';
import { hotWallet } from './solana.ts';

/**
 * On-chain surface for Classic Gacha (docs/classic-gacha-cc-packs-spec.md §5, P1). Two ops the gacha service
 * needs; everything else (the actual CC payment + buyback broadcast, the reconcile status) goes through CC's
 * own `submitTransaction` / `getPackStatus`, so this stays small.
 *
 * Injectable (the service takes a `GachaChain`), so the money / idempotency / state-machine logic is tested
 * against a fake and the live Solana impl below is exercised only by the operator's real-funds test (the
 * spec's P1 "confirm CC mainnet + altPlayerAddress on a tiny live test" gate). The real impl is lazy-loaded
 * under REAL_FUNDS by the route — it never loads in play-money mode or tests.
 */
export interface GachaChain {
  /**
   * JIT-fund the user's NFT-custody wallet from the hot wallet so it can pay CC: `usdcE6` (the pack price)
   * + a little SOL for the CC tx fee and the USDC-ATA rent. Awaits finalized confirmation, so the funds are
   * in place before CC's payment tx executes. Returns the funding signature.
   */
  fundCustody(dest: string, usdcE6: bigint): Promise<{ sig: string }>;
  /** Sign a CC-provided unsigned base64 tx with `signer` (the user's custody keypair). Local; returns the
   *  signed base64 (CC's `submitTransaction` broadcasts it). Handles versioned + legacy transactions. */
  signTx(txB64: string, signer: Keypair): string;
  /** The hot wallet's pubkey — passed as CC `altRecipient` so a buyback's USDC lands straight in the hot
   *  wallet (never in a scanned/credited address). */
  hotPubkey(): string;
  /** Transfer a won NFT out of the user's custody wallet to their external `dest` (P2 withdraw). The hot
   *  wallet is the fee-payer (gas relay); `signer` (the custody keypair) is the NFT owner. Awaits confirmation.
   *  NOTE: standard SPL transfer — programmable-NFT (pNFT) slabs need the Token Metadata transfer
   *  (@metaplex-foundation/mpl-token-metadata, not yet wired); a pNFT will reject this (spec §15.2). */
  transferNft(mint: string, dest: string, signer: Keypair): Promise<{ sig: string }>;
}

// SOL top-up sent alongside the pack-price USDC so the custody wallet can cover the CC payment tx fee + its
// USDC-ATA rent. A guess for now — the live test confirms whether CC forces the signer to pay gas + the real
// cost; tune then. (If CC supports altPlayerAddress, JIT funding is skipped entirely — spec §5.)
const FUND_SOL_LAMPORTS = 12_000_000; // 0.012 SOL

export function solanaGachaChain(): GachaChain {
  const conn = new Connection(config.solanaRpcUrl, 'finalized');
  const usdcMint = new PublicKey(config.usdcMint);

  return {
    async fundCustody(dest, usdcE6) {
      const hot = hotWallet();
      const destOwner = new PublicKey(dest);
      const fromAta = getAssociatedTokenAddressSync(usdcMint, hot.publicKey);
      const toAta = getAssociatedTokenAddressSync(usdcMint, destOwner);
      const tx = new Transaction().add(
        SystemProgram.transfer({ fromPubkey: hot.publicKey, toPubkey: destOwner, lamports: FUND_SOL_LAMPORTS }),
        createAssociatedTokenAccountIdempotentInstruction(hot.publicKey, toAta, destOwner, usdcMint),
        createTransferInstruction(fromAta, toAta, hot.publicKey, usdcE6),
      );
      tx.feePayer = hot.publicKey;
      const bh = await conn.getLatestBlockhash('finalized');
      tx.recentBlockhash = bh.blockhash;
      tx.sign(hot);
      const sig = await conn.sendRawTransaction(tx.serialize());
      await conn.confirmTransaction({ signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, 'finalized');
      return { sig };
    },

    hotPubkey() {
      return hotWallet().publicKey.toBase58();
    },

    signTx(txB64, signer) {
      const buf = Buffer.from(txB64, 'base64');
      try {
        const v = VersionedTransaction.deserialize(buf);
        v.sign([signer]);
        return Buffer.from(v.serialize()).toString('base64');
      } catch {
        const t = Transaction.from(buf);
        t.partialSign(signer);
        return t.serialize({ requireAllSignatures: false }).toString('base64');
      }
    },

    async transferNft(mint, dest, signer) {
      const hot = hotWallet();
      const mintPk = new PublicKey(mint);
      const destOwner = new PublicKey(dest);
      const fromAta = getAssociatedTokenAddressSync(mintPk, signer.publicKey);
      const toAta = getAssociatedTokenAddressSync(mintPk, destOwner, true); // allow a program-owned dest (vault/multisig)
      const tx = new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(hot.publicKey, toAta, destOwner, mintPk),
        createTransferInstruction(fromAta, toAta, signer.publicKey, 1n),
      );
      tx.feePayer = hot.publicKey; // gas relay — the custody wallet need not hold SOL
      const bh = await conn.getLatestBlockhash('finalized');
      tx.recentBlockhash = bh.blockhash;
      tx.sign(hot, signer); // hot = fee payer; signer = NFT owner
      const sig = await conn.sendRawTransaction(tx.serialize());
      await conn.confirmTransaction({ signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, 'finalized');
      return { sig };
    },
  };
}
