import type { Db } from '../db/client.ts';
import { config } from '../config.ts';
import { getMachines } from './providers/collectorcrypt.ts';

/**
 * Persist Collector Crypt machine stock so the operator sees restocks that happened while no admin tab was
 * open (the in-tab up-arrow only diffs live polls). A worker calls `pollMachineStock` every few minutes: for
 * each machine/tier it compares the live CC count to the last stored count, appends a `gacha_restock_events`
 * row on any INCREASE (a restock), and upserts the latest count (incl. decreases from pulls) so the next poll
 * diffs correctly. The first sighting of a tier just records it (no event, no baseline). Web3-free (CC read
 * client + DB). `getMachinesFn` is injectable for tests; defaults to the real CC client.
 * Meant to run SERIALLY: the boot worker holds a `gacha-stock-poll` lease, so the read-baseline/log/upsert is
 * never raced by a concurrent pass (and a stray duplicate would only be a cosmetic display row anyway).
 */
type MachinesFn = () => Promise<{ machines: Array<{ code?: string; stock?: Record<string, number> | null }> }>;
export interface StockPollResult { machines: number; tiers: number; restocks: number }

const key = (code: string, tier: string) => `${code}|${tier}`; // '|' never appears in a CC machine code or tier

export async function pollMachineStock(db: Db, opts: { getMachinesFn?: MachinesFn } = {}): Promise<StockPollResult> {
  const out: StockPollResult = { machines: 0, tiers: 0, restocks: 0 };
  if (!config.classicGachaEnabled) return out;
  const fetchMachines = opts.getMachinesFn ?? (() => getMachines());
  const { machines } = await fetchMachines();

  // one read of the current baseline, then diff in memory (vs a SELECT per tier).
  const prevRows = (await db.query<{ machine_code: string; tier: string; stock: number }>(
    `SELECT machine_code, tier, stock FROM gacha_machine_stock`)).rows;
  const prev = new Map(prevRows.map((r) => [key(r.machine_code, r.tier), r.stock]));

  for (const m of machines ?? []) {
    if (!m?.code || !m.stock) continue;
    out.machines++;
    for (const [tier, raw] of Object.entries(m.stock)) {
      out.tiers++;
      const to = Math.max(0, Math.trunc(Number(raw) || 0)); // clamp a junk/negative CC count to a non-negative int
      const before = prev.get(key(m.code, tier));
      if (before != null && to > before) {
        await db.query(
          `INSERT INTO gacha_restock_events(machine_code, tier, from_stock, to_stock, delta) VALUES($1,$2,$3,$4,$5)`,
          [m.code, tier, before, to, to - before]);
        out.restocks++;
      }
      await db.query(
        `INSERT INTO gacha_machine_stock(machine_code, tier, stock, updated_at) VALUES($1,$2,$3, now())
         ON CONFLICT (machine_code, tier) DO UPDATE SET stock = EXCLUDED.stock, updated_at = now()`,
        [m.code, tier, to]);
    }
  }
  return out;
}

export interface RestockEvent { machineCode: string; tier: string; fromStock: number; toStock: number; delta: number; detectedAt: string }

/** Recent restocks (newest first) for the admin readout. */
export async function recentRestocks(db: Db, opts: { limit?: number; sinceHours?: number } = {}): Promise<RestockEvent[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const since = new Date(Date.now() - (opts.sinceHours ?? 168) * 3_600_000).toISOString(); // default last 7 days
  const r = await db.query<{ machine_code: string; tier: string; from_stock: number; to_stock: number; delta: number; detected_at: string }>(
    `SELECT machine_code, tier, from_stock, to_stock, delta, detected_at FROM gacha_restock_events
      WHERE detected_at >= $1 ORDER BY detected_at DESC, id DESC LIMIT $2`, [since, limit]);
  return r.rows.map((e) => ({ machineCode: e.machine_code, tier: e.tier, fromStock: e.from_stock, toStock: e.to_stock, delta: e.delta, detectedAt: e.detected_at }));
}
