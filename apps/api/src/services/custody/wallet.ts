import { Keypair } from '@solana/web3.js';
import { derivePath } from 'ed25519-hd-key';
import { config } from '../../config.ts';
import type { Db } from '../../db/client.ts';

/**
 * Per-user HD deposit wallets (docs/real-funds-custody-plan.md, P1).
 * One master seed derives every deposit address at m/44'/501'/{index}'/0' (Solana BIP44,
 * fully hardened — ed25519 only supports hardened derivation).
 *
 * The seed is read from the environment for dev/devnet (DEPOSIT_MASTER_SEED, hex) and is
 * deliberately NOT placed on the config object so it can't leak through config logging.
 * Mainnet uses a KMS-held seed via config.depositSeedKmsRef (custody P4 — not implemented).
 */

function masterSeedHex(): string {
  const seed = process.env.DEPOSIT_MASTER_SEED ?? '';
  if (seed) {
    if (!/^[0-9a-fA-F]{64,128}$/.test(seed)) {
      throw new Error('DEPOSIT_MASTER_SEED must be 32-64 bytes of hex');
    }
    return seed;
  }
  if (config.depositSeedKmsRef) {
    throw new Error('KMS-held deposit seed is not implemented yet (custody P4)');
  }
  throw new Error('deposit wallets unavailable: set DEPOSIT_MASTER_SEED (dev/devnet)');
}

export function deriveDepositKeypair(index: number): Keypair {
  const { key } = derivePath(`m/44'/501'/${index}'/0'`, masterSeedHex());
  return Keypair.fromSeed(key);
}

/**
 * Per-user NFT-custody wallet (Classic Gacha, docs/classic-gacha-cc-packs-spec.md §5). Derived from the
 * SAME master seed + the user's deposit `index`, but on the `…/1'` change path so it is a DIFFERENT address
 * than the deposit wallet (`…/0'`) and is NEVER enumerated by the deposit scanner / swept. It holds won
 * graded-card NFTs (and is the payer + recipient when buying a CC pack). Deriving it on demand from the
 * stored index means no extra table.
 */
export function deriveNftCustodyKeypair(index: number): Keypair {
  const { key } = derivePath(`m/44'/501'/${index}'/1'`, masterSeedHex());
  return Keypair.fromSeed(key);
}

/** The user's NFT-custody keypair, keyed to their deposit derivation index (allocates the index if needed). */
export async function getNftCustodyKeypair(db: Db, userId: string): Promise<Keypair> {
  const { derivationIndex } = await getOrCreateDepositAddress(db, userId);
  return deriveNftCustodyKeypair(derivationIndex);
}

export interface DepositAddress {
  userId: string;
  address: string;
  derivationIndex: number;
}

/** Idempotent per user; allocates the next derivation index on first call. */
export async function getOrCreateDepositAddress(db: Db, userId: string): Promise<DepositAddress> {
  const existing = await db.query<{ address: string; derivation_index: number }>(
    `SELECT address, derivation_index FROM deposit_addresses WHERE user_id = $1`,
    [userId],
  );
  if (existing.rows[0]) {
    return { userId, address: existing.rows[0].address, derivationIndex: existing.rows[0].derivation_index };
  }

  // Allocate the next index. A concurrent allocation trips UNIQUE(derivation_index) (or the
  // user_id PK if the same user raced) — re-read and retry with a fresh MAX.
  for (let attempt = 0; attempt < 3; attempt++) {
    const next = await db.query<{ next: number }>(
      `SELECT COALESCE(MAX(derivation_index), -1) + 1 AS next FROM deposit_addresses`,
    );
    const index = Number(next.rows[0].next);
    const address = deriveDepositKeypair(index).publicKey.toBase58();
    try {
      await db.query(
        `INSERT INTO deposit_addresses(user_id, address, derivation_index) VALUES($1, $2, $3)`,
        [userId, address, index],
      );
      return { userId, address, derivationIndex: index };
    } catch {
      const raced = await db.query<{ address: string; derivation_index: number }>(
        `SELECT address, derivation_index FROM deposit_addresses WHERE user_id = $1`,
        [userId],
      );
      if (raced.rows[0]) {
        return { userId, address: raced.rows[0].address, derivationIndex: raced.rows[0].derivation_index };
      }
    }
  }
  throw new Error('could not allocate a deposit address (derivation-index contention)');
}
