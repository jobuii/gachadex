import type { Db } from '../db/client.ts';

/**
 * Single-leader leases for background loops (P5). With N API instances, only the holder of a loop's
 * lease runs its pass — the others skip. This guards against DUPLICATE WORK (N× provider budget,
 * N× oracle prints); the provider RATE limit is already multi-instance-safe via provider_rate.
 *
 * Semantics: one row per loop. Acquiring succeeds when the lease is free/expired, or when the caller
 * already holds it (renewal). If a holder dies, the next instance takes over after expiry — so a TTL
 * should be modest (≈ one pass), not the loop interval, or a restart blocks the loop until expiry.
 */

/** Acquire or renew `key` for ttlMs. True = this process may run the pass. */
export async function tryAcquireLease(db: Db, key: string, holder: string, ttlMs: number): Promise<boolean> {
  const r = await db.query<{ key: string }>(
    `INSERT INTO worker_leases(key, holder, expires_at)
     VALUES($1, $2, now() + ($3::int * interval '1 millisecond'))
     ON CONFLICT(key) DO UPDATE
       SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at
       WHERE worker_leases.expires_at < now() OR worker_leases.holder = EXCLUDED.holder
     RETURNING key`,
    [key, holder, ttlMs],
  );
  return r.rows.length > 0;
}

/** Release early (only if still ours) so a successor needn't wait out the TTL. */
export async function releaseLease(db: Db, key: string, holder: string): Promise<void> {
  await db.query(`DELETE FROM worker_leases WHERE key = $1 AND holder = $2`, [key, holder]);
}
