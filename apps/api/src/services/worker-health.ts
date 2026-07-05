/**
 * Custody worker health (custody observability + the RPC-outage alert). Each RPC-dependent custody loop
 * records the outcome of every pass into `worker_health` (DB-only). Two consumers read it:
 *   1. GET /admin/custody-health — a live readout in the admin panel (works even when the RPC is down,
 *      because it reads the DB, not the chain — unlike the treasury/PoR report which needs the chain).
 *   2. checkAndAlert() — an edge-triggered incident/recovery push to the configured operator channels.
 *
 * Why this exists: an RPC outage (e.g. Helius out of credits) does NOT stop the exchange — trading and
 * balances are entirely off-chain. But it silently stalls deposits, withdrawals, and proof-of-reserves,
 * and previously nothing surfaced that: the errors went only to the server log and the treasury box just
 * vanished. This turns that silent failure into a loud one.
 */
import type { Db } from '../db/client.ts';
import { config } from '../config.ts';
import { sendAlert, alertingEnabled, channelsConfigured } from './notify.ts';

export type HealthComponent = 'deposit_scan' | 'withdrawal_process' | 'treasury_por';

const LABELS: Record<HealthComponent, string> = {
  deposit_scan: 'Deposit scan',
  withdrawal_process: 'Withdrawal processing',
  treasury_por: 'Proof-of-reserves',
};

const ALERT_STATE_KEY = 'custody_alert_state'; // system_flags row; reason = JSON { components: string[] }

type Logger = { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };

/** A pass succeeded: stamp last_ok_at and clear the failure streak. */
export async function recordOk(db: Db, component: HealthComponent): Promise<void> {
  await db.query(
    `INSERT INTO worker_health(component, last_ok_at, fail_streak, updated_at) VALUES($1, now(), 0, now())
     ON CONFLICT(component) DO UPDATE SET last_ok_at = now(), fail_streak = 0, updated_at = now()`,
    [component],
  );
}

// RPC/HTTP errors routinely embed the endpoint URL, and provider URLs carry the key (e.g. Helius
// `?api-key=…`, or an `Authorization: Bearer …`). This message is stored AND pushed to external alert
// channels, so redact credential-bearing tokens before it ever leaves the process.
function redactSecrets(s: string): string {
  return s
    .replace(/\b((?:api[-_]?key|access[-_]?token|token|secret|key)=)[^&\s'"]+/gi, '$1***')
    .replace(/\b(bearer\s+)[\w.\-]+/gi, '$1***');
}

/** A pass failed: stamp last_err_at + the (redacted) message and increment the consecutive-failure streak. */
export async function recordErr(db: Db, component: HealthComponent, err: unknown): Promise<void> {
  const msg = redactSecrets((err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ')).slice(0, 500);
  await db.query(
    `INSERT INTO worker_health(component, last_err_at, last_err, fail_streak, updated_at) VALUES($1, now(), $2, 1, now())
     ON CONFLICT(component) DO UPDATE SET last_err_at = now(), last_err = $2, fail_streak = worker_health.fail_streak + 1, updated_at = now()`,
    [component, msg],
  );
}

export type HealthStatus = 'idle' | 'ok' | 'warn' | 'bad';

export interface ComponentHealth {
  component: HealthComponent;
  label: string;
  lastOkAt: string | null;
  lastErrAt: string | null;
  lastErr: string | null;
  failStreak: number;
  degraded: boolean; // actively failing past the threshold (streak + a recent error) — the RPC-down signal
  status: HealthStatus; // idle (not running / no data) · ok · warn (running, not succeeding) · bad (degraded)
}

export interface WorkerHealthView {
  custodyActive: boolean; // custody workers only run under REAL_FUNDS; false ⇒ nothing to monitor (play-money)
  rpcHealthy: boolean; // canonical on-chain-read signal: the PoR pass isn't degraded
  porLastVerifiedAt: string | null; // when proof-of-reserves last read the chain successfully
  components: ComponentHealth[];
  stalledWithdrawals: number; // queued > withdrawalStallMs (a symptom of the outage; DB-only, no RPC)
  pendingWithdrawals: number;
  alertChannels: string[]; // configured push channels (so the operator can see alerting is actually wired)
}

const ORDER: HealthComponent[] = ['treasury_por', 'deposit_scan', 'withdrawal_process'];

/** Full health view for the admin readout + the alert body. DB-only — safe while the RPC is down. */
export async function getWorkerHealth(db: Db, now: () => number = Date.now): Promise<WorkerHealthView> {
  // ::text for display; EXTRACT(EPOCH …) for the recency math — parsed numerically in SQL, so the
  // freshness logic never depends on JS Date.parse of a DB timestamp string (whose exact format varies).
  const rows = await db.query<{
    component: string;
    last_ok_at: string | null;
    last_err_at: string | null;
    last_err: string | null;
    fail_streak: number;
    ok_epoch: string | null;
    err_epoch: string | null;
  }>(
    `SELECT component, last_ok_at::text, last_err_at::text, last_err, fail_streak,
            EXTRACT(EPOCH FROM last_ok_at) AS ok_epoch, EXTRACT(EPOCH FROM last_err_at) AS err_epoch
       FROM worker_health`,
  );
  const byId = new Map(rows.rows.map((r) => [r.component, r]));
  const threshold = config.custodyAlertFailStreak;
  const t = now();

  const components: ComponentHealth[] = ORDER.map((component) => {
    const r = byId.get(component);
    const failStreak = r ? Number(r.fail_streak) : 0;
    const lastOkAt = r?.last_ok_at ?? null;
    const lastErrAt = r?.last_err_at ?? null;
    const okMs = r?.ok_epoch != null ? Number(r.ok_epoch) * 1000 : NaN;
    const errMs = r?.err_epoch != null ? Number(r.err_epoch) * 1000 : NaN;
    const okRecent = Number.isFinite(okMs) && t - okMs <= config.custodyStaleMs;
    const errRecent = Number.isFinite(errMs) && t - errMs <= config.custodyStaleMs;
    // A loop is "active" if it ran (ok OR err) within the stale window. One that simply STOPPED running
    // (never started, e.g. withdrawal auto-process off; or an incident that turned a loop off) reads as
    // idle, not alarming — and "degraded" also requires a RECENT error, so a frozen fail_streak on a
    // stopped loop ages out and lets a lingering incident clear instead of getting stuck red forever.
    const degraded = failStreak >= threshold && errRecent;
    const active = okRecent || errRecent;
    const status: HealthStatus = degraded ? 'bad' : !active ? 'idle' : okRecent ? 'ok' : 'warn';
    return { component, label: LABELS[component], lastOkAt, lastErrAt, lastErr: r?.last_err ?? null, failStreak, degraded, status };
  });

  const por = components.find((c) => c.component === 'treasury_por')!;
  // "Stalled" = processing STARTED but didn't finish (signed/broadcast, aged past the window) — a real
  // outage symptom in any mode. A 'requested' row is excluded: in the default manual-approval flow it
  // legitimately waits for an operator, so counting it would cry wolf. `pending` is the whole queue.
  const w = await db.query<{ pending: number; stalled: number }>(
    `SELECT COUNT(*)::int AS pending,
            COALESCE(SUM(CASE WHEN status IN ('signed', 'broadcast') AND requested_at < now() - ($1 || ' milliseconds')::interval THEN 1 ELSE 0 END), 0)::int AS stalled
       FROM withdrawals WHERE status IN ('requested', 'signed', 'broadcast')`,
    [String(config.withdrawalStallMs)],
  );

  return {
    custodyActive: config.realFunds,
    rpcHealthy: !por.degraded,
    porLastVerifiedAt: por.lastOkAt,
    components,
    stalledWithdrawals: Number(w.rows[0]?.stalled ?? 0),
    pendingWithdrawals: Number(w.rows[0]?.pending ?? 0),
    alertChannels: channelsConfigured(),
  };
}

async function getAlertedSet(db: Db): Promise<Set<string>> {
  const r = await db.query<{ reason: string }>(`SELECT reason FROM system_flags WHERE key = $1`, [ALERT_STATE_KEY]);
  if (!r.rows[0]) return new Set();
  try {
    const parsed = JSON.parse(r.rows[0].reason) as { components?: string[] };
    return new Set(parsed.components ?? []);
  } catch {
    return new Set();
  }
}
async function setAlertedSet(db: Db, components: string[]): Promise<void> {
  await db.query(
    `INSERT INTO system_flags(key, reason) VALUES($1, $2)
     ON CONFLICT(key) DO UPDATE SET reason = EXCLUDED.reason, updated_at = now()`,
    [ALERT_STATE_KEY, JSON.stringify({ components })],
  );
}
async function clearAlertedSet(db: Db): Promise<void> {
  await db.query(`DELETE FROM system_flags WHERE key = $1`, [ALERT_STATE_KEY]);
}

function ago(iso: string | null, t: number): string {
  if (!iso) return 'never';
  const ms = t - Date.parse(iso); // display only; V8 parses Postgres' space-separated ::text form fine
  if (!Number.isFinite(ms)) return 'unknown';
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

/**
 * Edge-triggered alerting. Fires ONE incident push when a custody component first crosses the failure
 * threshold (or escalates to more components), and ONE recovery push when everything clears — never a
 * per-pass alert. State (which components we've alerted on) is persisted in system_flags so it survives
 * restarts. Driven from a SINGLE loop (the treasury pass), which matches the custody deployment model
 * (the custody workers aren't lease-guarded — they run on one instance). No-op when no channel is set.
 */
export async function checkAndAlert(db: Db, log?: Logger, now: () => number = Date.now): Promise<void> {
  if (!alertingEnabled()) return;
  const view = await getWorkerHealth(db, now);
  const affected = view.components.filter((c) => c.degraded);
  const degraded = affected.map((c) => c.component);
  const prev = await getAlertedSet(db);
  const newlyDegraded = degraded.filter((c) => !prev.has(c));
  const t = now();

  if (degraded.length > 0 && newlyDegraded.length > 0) {
    // Incident start, or escalation (a component degraded that we hadn't alerted on yet).
    const lines = affected.map((c) => `• ${c.label}: ${c.failStreak} consecutive fails, last OK ${ago(c.lastOkAt, t)}${c.lastErr ? ` — ${c.lastErr}` : ''}`);
    const body =
      `Affected:\n${lines.join('\n')}\n\n` +
      `Stalled withdrawals: ${view.stalledWithdrawals} (queued > ${Math.round(config.withdrawalStallMs / 60_000)}m)\n\n` +
      `Impact: trading & customer balances are UNAFFECTED (off-chain). New deposits are not being credited, ` +
      `withdrawals are paused, and proof-of-reserves is not verifying — until the RPC recovers.\n` +
      `Likely cause: the Solana RPC (SOLANA_RPC_URL / Helius) is unreachable or out of credits. Check the RPC provider.`;
    await sendAlert('🔴 GachaDex custody incident — Solana RPC unreachable', body, log);
    await setAlertedSet(db, degraded);
  } else if (degraded.length === 0 && prev.size > 0) {
    // Full recovery.
    await sendAlert(
      '🟢 GachaDex custody recovered',
      `All custody workers are healthy again. Proof-of-reserves last verified ${ago(view.porLastVerifiedAt, t)}. ` +
        `Pending withdrawals: ${view.pendingWithdrawals}.`,
      log,
    );
    await clearAlertedSet(db);
  } else if (degraded.length !== prev.size) {
    // Partial de-escalation (some cleared, some still degraded) — update the tracked set, no new alert.
    await setAlertedSet(db, degraded);
  }
}

/**
 * Wrap one custody-worker pass: run it and record ok/err (keeping the existing per-pass logging). Errors
 * are swallowed here exactly as the callers already did (the loop always retries) — this only adds the
 * health bookkeeping. Alerting is NOT done here: it's driven from a single loop (the treasury pass) so it
 * can't interleave/duplicate across the three custody loops. Returns void so it drops into chainLoop.
 */
export async function trackPass<T>(
  db: Db,
  component: HealthComponent,
  log: Logger,
  run: () => Promise<T>,
  onOk?: (r: T) => void,
): Promise<void> {
  try {
    const r = await run();
    onOk?.(r);
    await recordOk(db, component);
  } catch (e) {
    log.error(e, `${component} failed (will retry)`);
    await recordErr(db, component, e).catch((e2) => log.error(e2, 'worker-health recordErr failed'));
  }
}
