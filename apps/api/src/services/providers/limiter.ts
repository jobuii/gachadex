import type { Db } from '../../db/client.ts';

/**
 * Global request limiter for an external price provider (tcgpricelookup: 1 req/s, 10k/day — per API
 * KEY, not per process). Two layers:
 *
 *  - GLOBAL pacing + budget: the token-bucket state lives in `provider_rate` (one row per provider).
 *    Every instance claims its next send-slot in a SELECT..FOR UPDATE transaction, so N instances
 *    serialize to one provider-paced stream and share one daily budget. No leader election needed for
 *    rate safety — the DB row IS the single source of slots.
 *
 *  - LOCAL priority: callers declare what the request is for, and higher priorities always claim the
 *    next slot first within this process: user search > oracle refresh > discovery crawl. Each tier
 *    also has a soft DAILY ceiling (fraction of the cap) so background work can never exhaust the
 *    budget user-facing search needs.
 */
export type ProviderPriority = 'search' | 'refresh' | 'discovery';

const PRIORITY_ORDER: ProviderPriority[] = ['search', 'refresh', 'discovery'];
// Per-tier share of the daily cap. Search may spend up to the full cap; refresh stops at 90% (leaving
// headroom for search); discovery stops at 60% (it's a background crawl — always the first to yield).
const DAILY_CEILING: Record<ProviderPriority, number> = { search: 1.0, refresh: 0.9, discovery: 0.6 };

/** Thrown when a tier's share of the provider's daily budget is spent. Callers skip/defer, never crash. */
export class ProviderBudgetError extends Error {
  constructor(priority: ProviderPriority, used: number, cap: number) {
    super(`provider budget: '${priority}' ceiling reached (${used}/${cap} requests today)`);
    this.name = 'ProviderBudgetError';
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Waiter {
  resolve: () => void;
  reject: (e: Error) => void;
}

export class ProviderLimiter {
  private queues: Record<ProviderPriority, Waiter[]> = { search: [], refresh: [], discovery: [] };
  private pumping = false;

  constructor(
    private db: Db,
    private key: string,
    private opts: { minIntervalMs: number; dailyCap: number },
  ) {}

  /** Resolves when the caller may send ONE request (its global slot has arrived). */
  acquire(priority: ProviderPriority): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queues[priority].push({ resolve, reject });
      void this.pump();
    });
  }

  private next(): { priority: ProviderPriority; waiter: Waiter } | null {
    for (const priority of PRIORITY_ORDER) {
      const waiter = this.queues[priority].shift();
      if (waiter) return { priority, waiter };
    }
    return null;
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (let n = this.next(); n; n = this.next()) {
        const { priority, waiter } = n;
        try {
          const waitMs = await this.claimSlot(priority);
          if (waitMs > 0) await sleep(waitMs);
          waiter.resolve();
        } catch (e) {
          waiter.reject(e as Error);
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  /** Claim the next global send-slot; returns how long to wait until it arrives. */
  private async claimSlot(priority: ProviderPriority): Promise<number> {
    return this.db.tx(async (q) => {
      await q.query(`INSERT INTO provider_rate(key) VALUES($1) ON CONFLICT(key) DO NOTHING`, [this.key]);
      const r = await q.query<{ rollover: boolean; used_today: number; wait_ms: string }>(
        `SELECT (day < CURRENT_DATE) AS rollover, used_today,
                GREATEST(0, CEIL(EXTRACT(EPOCH FROM (next_slot_at - now())) * 1000))::bigint::text AS wait_ms
         FROM provider_rate WHERE key = $1 FOR UPDATE`,
        [this.key],
      );
      const used = r.rows[0].rollover ? 0 : r.rows[0].used_today;
      const ceiling = Math.floor(this.opts.dailyCap * DAILY_CEILING[priority]);
      if (used >= ceiling) throw new ProviderBudgetError(priority, used, ceiling);
      await q.query(
        `UPDATE provider_rate
            SET next_slot_at = GREATEST(next_slot_at, now()) + ($2::int * interval '1 millisecond'),
                used_today = CASE WHEN day < CURRENT_DATE THEN 1 ELSE used_today + 1 END,
                day = CURRENT_DATE
          WHERE key = $1`,
        [this.key, this.opts.minIntervalMs],
      );
      return Number(r.rows[0].wait_ms);
    });
  }
}
