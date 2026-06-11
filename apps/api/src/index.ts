import { buildServer } from './server.ts';
import { initDb } from './db/init.ts';
import { ingest } from './services/oracle.ts';
import { accrueFunding } from './services/funding.ts';
import { liquidateEligible, haltStaleMarkets, autoDeleverage } from './services/engine.ts';
import { scanDeposits } from './services/custody/deposits.ts';
import { recoverInFlight, processAllRequested } from './services/custody/withdrawals.ts';
import { treasuryPass } from './services/custody/treasury.ts';
import { loadLimits } from './services/custody/limits.ts';
import { loadFee } from './services/fees.ts';
import { solanaDepositChain, solanaWithdrawChain, solanaTreasuryChain } from './services/custody/solana.ts';
import type { Db } from './db/client.ts';
import type { FastifyBaseLogger } from 'fastify';
import { config } from './config.ts';

// The oracle/funding loops below stay on plain setInterval: their bodies are fast local-DB work,
// so overlap is a non-issue. The liquidation sweep and the custody workers use chainLoop — passes
// that can run long or must never stack (ADL iterates; custody does slow RPC) self-chain instead.
function startOracleLoop(db: Db, log: FastifyBaseLogger) {
  const run = () =>
    ingest(db)
      .then((r) => log.info(r, 'oracle ingest complete'))
      .catch((e) => log.error(e, 'oracle ingest failed (will retry)'));
  // initial run shortly after boot, then on the configured interval
  setTimeout(run, 1500);
  setInterval(run, config.oracleRefreshMs);
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
    startFundingLoop(db, app.log);
    startLiquidationLoop(db, app.log);
    // Live trading-fee override (works in both modes — trading happens in play money too). Loaded on
    // boot, then refreshed for multi-instance convergence + to pick up admin edits within ~30s.
    await loadFee(db);
    setInterval(() => void loadFee(db).catch((e) => app.log.warn(e, 'fee refresh failed')), 30_000);
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
