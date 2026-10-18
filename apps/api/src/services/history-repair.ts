/**
 * Shared machinery for the price-history repair tools (price-cleanup.ts, price-backfill.ts, index-rebuild.ts): one
 * backup table (history_repair_backup) keyed by run id, one writer for historical points, one exact revert. Every
 * statement is set-based — these run once against prod over the network, so per-row round trips would cost minutes
 * inside an open transaction.
 */
import { randomUUID } from 'node:crypto';
import type { Db, Queryer } from '../db/client.ts';
import { tryAcquireLease, releaseLease, ORACLE_INGEST_LEASE } from './lease.ts';

export type RepairKind = 'rebuild' | 'cleanup' | 'backfill' | 'printing';

export const newRepairRunId = (kind: RepairKind) => `${kind}-${new Date().toISOString()}-${randomUUID().slice(0, 8)}`;

/**
 * Run `fn` holding the oracle-ingest lease, so no live pass lands mid-repair (e.g. between a rebuild's PLAN and its
 * APPLY, where a pass's fresh mark would be rescaled against a stale plan). Throws if a pass is mid-flight.
 */
export async function withIngestLease<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  const owner = `history-repair:${randomUUID()}`;
  if (!(await tryAcquireLease(db, ORACLE_INGEST_LEASE, owner, 60 * 60_000))) {
    throw new Error('the oracle ingest is mid-pass (lease held) — retry in a few minutes');
  }
  try {
    return await fn();
  } finally {
    await releaseLease(db, ORACLE_INGEST_LEASE, owner).catch(() => {});
  }
}

export interface HistoricalPoint {
  marketId: string;
  valueE6: bigint;
  at: Date; // source_observed_at (+ the mark's computed_at)
  ingestedAt?: Date; // defaults to `at`; the index rebuild stamps a pass's cutoff so a re-run reads the same pass
  payload: Record<string, unknown>;
}

/**
 * Insert historical points — an accepted print (observed `at`, ingested `ingestedAt ?? at`) plus a mark (mark =
 * index = value, no skew, at `at`) each — and log both as inserted for revert. A (market, at) that already has a print is skipped. Batched:
 * one statement per ≤1000 points. Returns the number of points inserted.
 */
export async function insertHistoricalPoints(q: Queryer, runId: string, points: HistoricalPoint[]): Promise<number> {
  let n = 0;
  for (let i = 0; i < points.length; i += 1000) {
    const chunk = points.slice(i, i + 1000);
    const r = await q.query<{ row_id: string }>(
      `WITH ins AS (
         INSERT INTO oracle_prices(market_id, index_price_e6, raw_payload, source_observed_at, ingested_at, is_accepted)
         SELECT u.m, u.v, u.p, u.t, u.i, true FROM unnest($1::text[], $2::bigint[], $3::jsonb[], $4::timestamptz[], $6::timestamptz[]) AS u(m, v, p, t, i)
         ON CONFLICT(market_id, source_observed_at) DO NOTHING
         RETURNING id, market_id, index_price_e6, source_observed_at),
       mk AS (
         INSERT INTO marks(market_id, mark_price_e6, index_price_e6, skew_uusdc, premium_e6, computed_at)
         SELECT market_id, index_price_e6, index_price_e6, 0, 0, source_observed_at FROM ins RETURNING id, market_id),
       bp AS (
         INSERT INTO history_repair_backup(run_id, tbl, row_id, market_id, inserted)
         SELECT $5, 'oracle_prices', id::text, market_id, true FROM ins)
       INSERT INTO history_repair_backup(run_id, tbl, row_id, market_id, inserted)
       SELECT $5, 'marks', id::text, market_id, true FROM mk RETURNING row_id`,
      [
        chunk.map((p) => p.marketId),
        chunk.map((p) => p.valueE6.toString()),
        chunk.map((p) => JSON.stringify(p.payload)),
        chunk.map((p) => p.at.toISOString()),
        runId,
        chunk.map((p) => (p.ingestedAt ?? p.at).toISOString()),
      ],
    );
    n += r.rows.length;
  }
  return n;
}

/**
 * Undo one repair run: re-accept rejected prints, restore rewritten prints (value AND payload), marks and index
 * snapshots, delete inserted rows. Restores what the run changed — it can't un-happen what came after, so it
 * REFUSES (unless `force`) when (a) a later repair run touched the same markets (revert newest-first), or (b) a
 * rebuild run's indices have had a live pass since (that pass chained off the rebuilt level; reverting under it
 * would leave a step in the history).
 */
export async function revertHistoryRepair(db: Db, runId: string, opts: { force?: boolean } = {}): Promise<{ restored: number; deleted: number }> {
  if (!opts.force) {
    const later = await db.query<{ run_id: string }>(
      `SELECT DISTINCT b.run_id FROM history_repair_backup b
        WHERE b.run_id <> $1 AND b.created_at > (SELECT min(created_at) FROM history_repair_backup WHERE run_id = $1)
          AND b.market_id IN (SELECT market_id FROM history_repair_backup WHERE run_id = $1)`,
      [runId],
    );
    if (later.rows.length) throw new Error(`revert the later run(s) first: ${later.rows.map((r) => r.run_id).join(', ')} (or pass force)`);
    if (runId.startsWith('rebuild-')) {
      const live = await db.query(
        `SELECT 1 FROM oracle_prices o
          WHERE o.market_id IN (SELECT market_id FROM history_repair_backup WHERE run_id = $1)
            AND o.ingested_at > (SELECT min(created_at) FROM history_repair_backup WHERE run_id = $1)
            AND NOT (COALESCE(o.raw_payload->>'rebuilt', '') = $1) LIMIT 1`,
        [runId],
      );
      if (live.rows.length) throw new Error(`a live oracle pass has chained off rebuild ${runId} since it was applied — reverting would leave a step in the history (pass force to revert anyway)`);
    }
  }
  return db.tx(async (q) => {
    const snapshots = await q.query<{ market_id: string }>(
      `SELECT market_id FROM history_repair_backup WHERE run_id = $1 AND tbl = 'index_constituents'`,
      [runId],
    );
    for (const s of snapshots.rows) {
      await q.query(`DELETE FROM index_constituents WHERE market_id = $1`, [s.market_id]);
      await q.query(
        `INSERT INTO index_constituents(id, market_id, card_id, weight_e6)
         SELECT gen_random_uuid()::text, $2, e->>'card_id', (e->>'weight_e6')::bigint
           FROM history_repair_backup b, jsonb_array_elements(b.old_payload) e
          WHERE b.run_id = $1 AND b.tbl = 'index_constituents' AND b.market_id = $2`,
        [runId, s.market_id],
      );
    }
    const reaccepted = await q.query(
      `UPDATE oracle_prices o SET is_accepted = b.old_accepted, reject_reason = NULL FROM history_repair_backup b
        WHERE b.run_id = $1 AND b.tbl = 'oracle_prices' AND b.old_accepted IS NOT NULL AND o.id = b.row_id::bigint RETURNING o.id`,
      [runId],
    );
    const prints = await q.query(
      `UPDATE oracle_prices o SET index_price_e6 = b.old_index_e6, raw_payload = b.old_payload FROM history_repair_backup b
        WHERE b.run_id = $1 AND b.tbl = 'oracle_prices' AND NOT b.inserted AND b.old_accepted IS NULL AND o.id = b.row_id::bigint RETURNING o.id`,
      [runId],
    );
    const marks = await q.query(
      `UPDATE marks k SET mark_price_e6 = b.old_mark_e6, index_price_e6 = b.old_index_e6 FROM history_repair_backup b
        WHERE b.run_id = $1 AND b.tbl = 'marks' AND NOT b.inserted AND k.id = b.row_id::bigint RETURNING k.id`,
      [runId],
    );
    const delMarks = await q.query(
      `DELETE FROM marks WHERE id IN (SELECT row_id::bigint FROM history_repair_backup WHERE run_id = $1 AND tbl = 'marks' AND inserted) RETURNING id`,
      [runId],
    );
    const delPrints = await q.query(
      `DELETE FROM oracle_prices WHERE id IN (SELECT row_id::bigint FROM history_repair_backup WHERE run_id = $1 AND tbl = 'oracle_prices' AND inserted) RETURNING id`,
      [runId],
    );
    await q.query(`DELETE FROM history_repair_backup WHERE run_id = $1`, [runId]);
    return {
      restored: reaccepted.rows.length + prints.rows.length + marks.rows.length + snapshots.rows.length,
      deleted: delMarks.rows.length + delPrints.rows.length,
    };
  });
}
