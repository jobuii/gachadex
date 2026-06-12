import { buildServer } from './server.ts';
import { initDb } from './db/init.ts';
import { ingest } from './services/oracle.ts';
import { accrueFunding } from './services/funding.ts';
import { liquidateEligible, haltStaleMarkets, autoDeleverage } from './services/engine.ts';
import { scanDeposits } from './services/custody/deposits.ts';
import { recoverInFlight, processAllRequested } from './services/custody/withdrawals.ts';
import { treasuryPass } from './services/custody/treasury.ts';
import { loadLimits } from './services/custody/limits.ts';
import { loadFee, loadLiqFee } from './services/fees.ts';
import { tryAcquireLease, releaseLease } from './services/lease.ts';
import { getDefaultClient } from './services/providers/tcgpricelookup.ts';
import { discoverGame, dueForRebalance, markRebalanced } from './services/providers/discovery.ts';
import { countMissingHistory, seedMissingHistory } from './services/providers/history.ts';
import { GAMES } from '@pokex/shared-types';
import { randomUUID } from 'node:crypto';
import { solanaDepositChain, solanaWithdrawChain, solanaTreasuryChain } from './services/custody/solana.ts';
import type { Db } from './db/client.ts';
import type { FastifyBaseLogger } from 'fastify';
import { config } from './config.ts';

// The oracle/funding loops below stay on plain setInterval: their bodies are fast local-DB work,
// so overlap is a non-issue. The liquidation sweep and the custody workers use chainLoop — passes
// that can run long or must never stack (ADL iterates; custody does slow RPC) self-chain instead.
// Per-process identity for worker leases: with N instances only the lease holder runs a loop pass.
const INSTANCE_ID = randomUUID();

function startOracleLoop(db: Db, log: FastifyBaseLogger) {
  const run = async () => {
    // Concurrency guard (P5): the lease is PASS-scoped (TTL ~ one pass, released after), so no two
    // instances ever ingest at once, and a deploy/crash never blocks the next ingest for long. With
    // N staggered instances each may still run its own scheduled pass — harmless: tcgpricelookup
    // prints dedup on the provider timestamp, and the budget cost is bounded by the limiter.
    if (!(await tryAcquireLease(db, 'oracle-ingest', INSTANCE_ID, 15 * 60_000))) {
      log.info('oracle ingest: another instance is mid-pass — skipped');
      return;
    }
    try {
      const r = await ingest(db);
      log.info(r, 'oracle ingest complete');
    } catch (e) {
      log.error(e, 'oracle ingest failed (will retry)');
    } finally {
      await releaseLease(db, 'oracle-ingest', INSTANCE_ID).catch(() => {});
    }
  };
  // initial run shortly after boot, then on the configured interval
  setTimeout(() => void run(), 1500);
  setInterval(() => void run(), config.oracleRefreshMs);
}

/** Weekly featured rebalance (P4 discovery, P5 wiring). Inert until the tcgpricelookup cutover: the
 *  crawl prices via tcgpricelookup, and pre-cutover the pokemontcg feed owns pokemon's featured set. */
function startDiscoveryLoop(db: Db, log: FastifyBaseLogger) {
  if (config.oraclePrimary !== 'tcgpricelookup') return;
  const client = getDefaultClient(db); // the SAME instance as the refresh path — in-process priority preemption works across loops
  const run = async () => {
    try {
      // Chart seeding for any unseeded tracked market (new listings, prior failures): a cheap
      // NOT EXISTS probe every tick, so a chart appears within the hour rather than a week. The
      // sweep is one provider request per missing market — the 1h TTL covers a full-universe pass.
      if ((await countMissingHistory(db)) > 0 && (await tryAcquireLease(db, 'chart-seed', INSTANCE_ID, 60 * 60_000))) {
        try {
          const s = await seedMissingHistory(db, client, { log: (m) => log.info(m) });
          log.info(s, 'chart history seeded');
        } finally {
          await releaseLease(db, 'chart-seed', INSTANCE_ID).catch(() => {});
        }
      }
      if (!(await dueForRebalance(db, config.discoveryIntervalMs))) return;
      // TTL covers one full multi-game crawl (~30 min), NOT the weekly interval — a dead holder is
      // replaced within hours, and the settings timestamp (not the lease) enforces the cadence.
      if (!(await tryAcquireLease(db, 'discovery-rebalance', INSTANCE_ID, 2 * 60 * 60 * 1000))) return;
      try {
        for (const game of GAMES) {
          const r = await discoverGame(db, client, game, { apply: true, log: (m) => log.info(m) });
          log.info({ game, kept: r.kept, featured: r.top.length }, 'discovery rebalance complete');
        }
        await markRebalanced(db); // only after ALL games — a partial run resumes next tick
      } finally {
        await releaseLease(db, 'discovery-rebalance', INSTANCE_ID);
      }
    } catch (e) {
      log.error(e, 'discovery rebalance failed (crawl state is checkpointed; will resume)');
    }
  };
  // hourly ticks; dueForRebalance gates the weekly cadence and lets an interrupted crawl resume fast
  chainLoop(run, 5 * 60_000, 60 * 60_000);
}

function startFundingLoop(db: Db, log: FastifyBaseLogger) {
  const run = async () => {
    try {
      const r = await db.query<{ id: string }>(`SELECT id FROM markets WHERE tradeable AND status='active'`);
      for (const m of r.rows) await accrueFunding(db, m.id);
    } catch (e) {
      log.error(e, 'funding accrual failed');
    }
  };
  setInterval(() => void run(), config.fundingIntervalMs);
}

/** Self-chained worker loop: the next pass is scheduled only after the current one finishes, so
 *  slow RPC passes can never overlap/stack the way a setInterval-driven loop would. */
function chainLoop(run: () => Promise<void>, firstDelayMs: number, intervalMs: number) {
  const tick = async () => {
    try {
      await run();
    } finally {
      setTimeout(() => void tick(), intervalMs);
    }
  };
  setTimeout(() => void tick(), firstDelayMs);
}

/** Real-funds only (custody P1): poll deposit addresses, sweep + credit new USDC. */
function startDepositScanner(db: Db, log: FastifyBaseLogger) {
  const chain = solanaDepositChain();
  chainLoop(
    () =>
      scanDeposits(db, chain, log)
        .then((r) => {
          if (r.credited > 0) log.info(r, 'deposits credited');
        })
        .catch((e) => log.error(e, 'deposit scan failed (will retry)')),
    3000,
    config.depositScanMs,
  );
}

/** Real-funds only (custody P2): recover in-flight withdrawals on boot (crash safety — always),
 *  then process accepted ones on an interval only when WITHDRAWAL_AUTO_PROCESS is on (P2 default
 *  is manual operator approval via processWithdrawal). */
function startWithdrawalWorker(db: Db, log: FastifyBaseLogger) {
  const chain = solanaWithdrawChain();
  recoverInFlight(db, chain, log)
    .then((r) => {
      if (r.recovered > 0) log.info(r, 'in-flight withdrawals recovered');
    })
    .catch((e) => log.error(e, 'withdrawal boot recovery failed'));
  if (config.withdrawalAutoProcess) {
    chainLoop(
      () =>
        processAllRequested(db, chain, log)
          .then((r) => {
            if (r.confirmed > 0) log.info(r, 'withdrawals processed');
          })
          .catch((e) => log.error(e, 'withdrawal processing failed (will retry)')),
      config.withdrawalProcessMs,
      config.withdrawalProcessMs,
    );
  }
}

/** Real-funds only (custody P3): proof-of-reserves (auto-freeze on breach) + hot-float sweeps. */
function startTreasuryWorker(db: Db, log: FastifyBaseLogger) {
  const chain = solanaTreasuryChain();
  chainLoop(
    () =>
      treasuryPass(db, chain, log)
        .then((r) => {
          if (r.sweptE6 > 0n) log.info({ sweptE6: r.sweptE6.toString() }, 'hot-wallet excess swept to cold');
        })
        .catch((e) => log.error(e, 'treasury pass failed (will retry)')),
    config.treasuryPassMs,
    config.treasuryPassMs,
  );
}

function startLiquidationLoop(db: Db, log: FastifyBaseLogger) {
  // Self-chained (not setInterval): the per-market liquidation pass + the pool-wide ADL pass must
  // never overlap themselves, or two concurrent autoDeleverage runs reading the same stale pool
  // liability would over-deleverage. chainLoop schedules the next sweep only after this one finishes.
  chainLoop(
    async () => {
      try {
        const r = await db.query<{ id: string }>(`SELECT id FROM markets WHERE tradeable AND status IN ('active','reduce_only')`);
        for (const m of r.rows) await liquidateEligible(db, m.id);
        await autoDeleverage(db); // pool-wide: shed winner over-exposure once liability tops the ADL threshold
        await haltStaleMarkets(db, config.oracleStaleMs);
      } catch (e) {
        log.error(e, 'liquidation sweep failed');
      }
    },
    config.liquidationSweepMs,
    config.liquidationSweepMs,
  );
}

async function main() {
  const db = await initDb();
  const app = await buildServer();

  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(`GachaDex api listening on :${config.port} (REAL_FUNDS=${config.realFunds})`);
    startOracleLoop(db, app.log);
    startDiscoveryLoop(db, app.log); // no-op until ORACLE_PRIMARY=tcgpricelookup
    startFundingLoop(db, app.log);
    startLiquidationLoop(db, app.log);
    // Live trading-fee override (works in both modes — trading happens in play money too). Loaded on
    // boot, then refreshed for multi-instance convergence + to pick up admin edits within ~30s.
    const loadFees = (d: Db) => Promise.all([loadFee(d), loadLiqFee(d)]);
    await loadFees(db);
    setInterval(() => void loadFees(db).catch((e) => app.log.warn(e, 'fee refresh failed')), 30_000);
    if (config.realFunds) {
      await loadLimits(db); // pull operator overrides over the config defaults before custody runs
      setInterval(() => void loadLimits(db).catch((e) => app.log.warn(e, 'limits refresh failed')), 30_000);
      startDepositScanner(db, app.log);
      startWithdrawalWorker(db, app.log);
      startTreasuryWorker(db, app.log);
    }
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  const shutdown = async (signal: string) => {
    app.log.info(`received ${signal}, shutting down`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
