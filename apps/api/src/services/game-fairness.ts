import { randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Provable fairness for the Games surface (docs/games-spec.md). Commit-reveal over HMAC-SHA256, the
 * Stake/Boxed.GG model: the server commits to a secret `serverSeed` by publishing sha256(serverSeed)
 * up front; each play mixes the (public) clientSeed + an incrementing nonce; the seed is revealed when
 * it rotates, so any past play can be recomputed and checked against the commit hash.
 *
 * roll() is deterministic in (serverSeed, clientSeed, nonce, cursor): the same inputs always yield the
 * same float. `cursor` lets ONE play draw many independent values (Pack Rip: cursor 0 = the value band,
 * cursor 1 = the card within it; Set Poker later: cursor 0..4 = five cards).
 *
 * Uses only node:crypto (same primitives as auth.ts / scrydex.ts) — no new dependency.
 */

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** A fresh secret server seed + its public commitment hash. */
export function commitServerSeed(): { serverSeed: string; serverSeedHash: string } {
  const serverSeed = randomBytes(32).toString('hex');
  return { serverSeed, serverSeedHash: sha256(serverSeed) };
}

/** A default client seed for a brand-new player (they can override it from the fairness panel). */
export function freshClientSeed(): string {
  return randomBytes(8).toString('hex');
}

/**
 * Deterministic float in [0, 1) from HMAC-SHA256(serverSeed, "clientSeed:nonce:cursor"). The first 4
 * bytes of the digest are read as a big-endian uint32 and divided by 2^32 — uniform, reproducible, and
 * trivially re-derivable in a browser for the public verify path.
 */
export function roll(serverSeed: string, clientSeed: string, nonce: number, cursor: number): number {
  const digest = createHmac('sha256', serverSeed).update(`${clientSeed}:${nonce}:${cursor}`).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}

/** roll() mapped to an integer in [0, n) (0 when n <= 0). */
export function rollInt(serverSeed: string, clientSeed: string, nonce: number, cursor: number, n: number): number {
  if (n <= 0) return 0;
  return Math.floor(roll(serverSeed, clientSeed, nonce, cursor) * n);
}

/**
 * Pick a weighted index from `weights` using one roll. Returns the index whose cumulative weight first
 * exceeds roll·Σweights. Weights are relative (need not sum to anything); a non-positive total falls
 * back to index 0.
 */
export function weightedPick(serverSeed: string, clientSeed: string, nonce: number, cursor: number, weights: number[]): number {
  const total = weights.reduce((a, w) => a + (w > 0 ? w : 0), 0);
  if (total <= 0) return 0;
  let target = roll(serverSeed, clientSeed, nonce, cursor) * total;
  for (let i = 0; i < weights.length; i++) {
    target -= weights[i] > 0 ? weights[i] : 0;
    if (target < 0) return i;
  }
  return weights.length - 1;
}

/**
 * A provably-fair Fisher-Yates permutation of [0, n) — the spot assignment for The Break (which card goes
 * to which spot). Deterministic in (serverSeed, clientSeed, nonce): swap k (i = n-1 … 1) draws its partner
 * with rollInt at cursor `cursorBase + k`, so anyone can recompute the whole shuffle from the revealed seed.
 * `cursorBase` offsets past any cursors the same seed already spent (e.g. the case's card draws).
 */
export function fairShuffle(serverSeed: string, clientSeed: string, nonce: number, n: number, cursorBase = 0): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = rollInt(serverSeed, clientSeed, nonce, cursorBase + (n - 1 - i), i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Constant-time check that sha256(serverSeed) == serverSeedHash (the public verify primitive). */
export function verify(serverSeed: string, serverSeedHash: string): boolean {
  const a = Buffer.from(sha256(serverSeed), 'hex');
  let b: Buffer;
  try {
    b = Buffer.from(serverSeedHash, 'hex');
  } catch {
    return false;
  }
  return a.length === b.length && timingSafeEqual(a, b);
}
