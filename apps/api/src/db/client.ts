import { config } from '../config.ts';

/**
 * Database adapter. One small interface over two drivers:
 *   - local dev  -> PGlite (embedded Postgres, zero system deps)
 *   - production -> node-postgres Pool against DATABASE_URL (Neon/Supabase)
 * The SQL is identical; only the connection differs.
 *
 * Money columns are read with an explicit `::text` cast and parsed with BigInt()
 * so values are exact across both drivers (never floats).
 */

export interface QueryResult<T = any> {
  rows: T[];
}

export interface Queryer {
  query<T = any>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface Db extends Queryer {
  /** Run a multi-statement SQL string (used for schema/migrations). */
  exec(sql: string): Promise<void>;
  /** Run `fn` inside a transaction; commit on success, rollback on throw. */
  tx<T>(fn: (q: Queryer) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  driver: 'pglite' | 'pg';
}

let _db: Db | null = null;

async function createPglite(): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const fs = await import('node:fs');
  const dir = config.pgliteDir;
  const onDisk = !!dir && !dir.startsWith('memory');

  // A file-backed PGlite left un-checkpointed by an UNCLEAN stop (a hard kill, or a WSL distro halt that
  // skips graceful shutdown) keeps a stale postmaster.pid / socket lock behind, and the WASM Postgres then
  // aborts on the next boot ("Aborted in pg_initdb"). PGlite runs single-process, so any such lock is dead —
  // clear it so the cluster can run its normal crash recovery and KEEP the data.
  if (onDisk) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f === 'postmaster.pid' || f.startsWith('.s.PGSQL')) fs.rmSync(`${dir}/${f}`, { force: true });
      }
    } catch {
      /* dir doesn't exist yet — a fresh start, nothing to clear */
    }
  }

  let pg = new PGlite(dir);
  try {
    await pg.waitReady;
    await pg.query('SELECT 1'); // prove the cluster actually opens + answers
  } catch (e) {
    if (!onDisk) throw e;
    // truly torn (clearing the stale lock wasn't enough) — quarantine it + start fresh so dev is never
    // blocked. It's a re-seedable sandbox; the bad dir is kept for forensics.
    const quarantine = `${dir}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(dir, quarantine);
    } catch {
      /* best effort */
    }
    // eslint-disable-next-line no-console
    console.warn(`[db] PGlite at ${dir} could not open (unclean shutdown) — quarantined to ${quarantine}; starting fresh. Re-seed: pnpm --filter @pokex/api exec tsx scripts/seed-dev.ts`);
    pg = new PGlite(dir);
    await pg.waitReady;
  }
  return {
    driver: 'pglite',
    query: (text, params) => pg.query(text, params as any[]) as any,
    exec: async (sql) => {
      await pg.exec(sql);
    },
    tx: (fn) =>
      pg.transaction(async (t) => fn({ query: (text, params) => t.query(text, params as any[]) as any })),
    close: () => pg.close(),
  };
}

async function createPg(): Promise<Db> {
  const pgmod = await import('pg');
  const Pool = pgmod.default.Pool;
  const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
  return {
    driver: 'pg',
    query: (text, params) => pool.query(text, params as any[]) as any,
    exec: async (sql) => {
      await pool.query(sql);
    },
    tx: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const r = await fn({ query: (text, params) => client.query(text, params as any[]) as any });
        await client.query('COMMIT');
        return r;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** Get the process-wide DB handle (created on first call). */
export async function getDb(): Promise<Db> {
  if (_db) return _db;
  _db = config.databaseUrl ? await createPg() : await createPglite();
  return _db;
}

/**
 * Transaction-scoped advisory lock keyed by an arbitrary string. Serializes writers across
 * pool connections / API instances (auto-released at COMMIT/ROLLBACK). Under PGlite, which
 * already serializes all queries, this is effectively a no-op. Call as the FIRST statement
 * inside an engine transaction to make "single-writer per market" true at the DB level.
 */
export async function advisoryXactLock(q: Queryer, key: string): Promise<void> {
  await q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
}

/** For tests: close and drop the cached handle. */
export async function closeDb(): Promise<void> {
  if (_db) {
    await _db.close();
    _db = null;
  }
}
