import { config } from '../config.ts';
import type { Db } from './client.ts';

/** SQL: market `a` may be live without breaking the live-label guard — no OTHER live card market of its game holds its
 *  card_id. Every path that revives a delisted market checks it, so a revive is skipped instead of failing. */
export const liveLabelFree = (a: string): string =>
  `NOT EXISTS (SELECT 1 FROM markets o WHERE o.game = ${a}.game AND o.kind = 'card' AND o.card_id = ${a}.card_id
                 AND o.status <> 'delisted' AND o.id <> ${a}.id)`;

/** Backfill of markets.printing (normVariant in SQL — printing-markets.test.ts checks the two agree). Idempotent (NULL rows
 *  only) and never onto a key another market of the product holds, so it can't trip idx_markets_tcgplayer_printing — e.g.
 *  rows an older build created during a rollback; those stay NULL until their next upsert. */
export const PRINTING_BACKFILL_SQL = `
  UPDATE markets m SET printing = k.key
    FROM (SELECT id, NULLIF(replace(regexp_replace(lower(variant), '[^a-z0-9]', '', 'g'), '1st', 'first'), '') AS key
            FROM markets WHERE kind = 'card' AND printing IS NULL AND variant IS NOT NULL) k
   WHERE m.id = k.id AND k.key IS NOT NULL
     AND (m.tcgplayer_id IS NULL OR NOT EXISTS (SELECT 1 FROM markets o WHERE o.tcgplayer_id = m.tcgplayer_id AND o.id <> m.id
                                                  AND COALESCE(o.printing, '') = k.key))`;

/** idx_markets_tcgplayer: unique (one market per product) or not (printing markets), always under that name. */
async function setProductIndex(db: Db, unique: boolean): Promise<void> {
  await db.tx(async (q) => {
    await q.query(`DROP INDEX IF EXISTS idx_markets_tcgplayer`);
    await q.query(`CREATE ${unique ? 'UNIQUE ' : ''}INDEX idx_markets_tcgplayer ON markets(tcgplayer_id) WHERE tcgplayer_id IS NOT NULL`);
  });
}

/**
 * Boot-time market guards that depend on a switch or on the data, so they can't live in schema.sql (which runs as one
 * script and must never fail at boot). Each step logs and carries on if it can't apply.
 *
 * 0. Backfill markets.printing for rows that have none (PRINTING_BACKFILL_SQL).
 * 1. Printing markets (PRINTING_MARKETS_ENABLED): two printings of one TCGplayer product are two markets, so the
 *    one-market-per-product unique index has to go. It is replaced by a NON-unique index under the SAME name: older
 *    code runs `CREATE UNIQUE INDEX IF NOT EXISTS idx_markets_tcgplayer` on boot, finds the name taken and skips it —
 *    a rollback can never fail to boot because two printings exist. idx_markets_tcgplayer_printing (schema.sql) keeps
 *    one market per (product, printing). Switched off again, the unique index comes back only when no product has
 *    two markets (else it stays non-unique and says so).
 * 2. Live card labels: two live card markets of one game may never share card_id — the index baskets, constituent
 *    snapshots and PSA-10 writes all key on it (two printings under one label would be chained as one card).
 */
export async function applyMarketGuards(db: Db, log: (msg: string) => void = (m) => console.warn(`[market-guards] ${m}`)): Promise<void> {
  try {
    await db.query(PRINTING_BACKFILL_SQL);
  } catch (e) {
    log(`printing backfill not applied: ${(e as Error).message}`);
  }
  try {
    const idx = await db.query<{ unique: boolean }>(
      `SELECT i.indisunique AS unique FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'idx_markets_tcgplayer'`,
    );
    const unique = idx.rows[0]?.unique;
    if (config.printingMarketsEnabled && unique !== false) {
      await setProductIndex(db, false);
    } else if (!config.printingMarketsEnabled && unique === false) {
      const twins = await db.query(
        `SELECT 1 FROM markets WHERE tcgplayer_id IS NOT NULL GROUP BY tcgplayer_id HAVING count(*) > 1 LIMIT 1`,
      );
      if (twins.rows.length) {
        // creation paths still keep one market per product (mayJoinProduct); the index just can't say so yet
        log('PRINTING_MARKETS_ENABLED is off but printing markets exist — the one-market-per-product index stays non-unique');
      } else {
        await setProductIndex(db, true);
      }
    }
  } catch (e) {
    log(`printing index switch not applied: ${(e as Error).message}`);
  }
  try {
    await db.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_markets_live_card_id ON markets(game, card_id)
        WHERE kind = 'card' AND status <> 'delisted' AND card_id IS NOT NULL`,
    );
  } catch (e) {
    log(`live card label guard not applied (two live card markets share a card_id): ${(e as Error).message}`);
  }
}
