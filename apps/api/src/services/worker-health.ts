/**
 * Worker health (observability + outage alerts) for the loops whose silent failure hurts: the price feed
 * (oracle ingest) and the RPC-dependent custody loops. Each records the outcome of every pass into
 * `worker_health` (DB-only). Two consumers read it:
 *   1. GET /admin/custody-health — a live readout in the admin panel (works even when the RPC is down,
 *      because it reads the DB, not the chain — unlike the treasury/PoR report which needs the chain).
 *   2. checkAndAlert() — an edge-triggered incident/recovery push to the configured operator channels.
 *
 * Why this exists: an RPC outage (e.g. Helius out of credits) does NOT stop the exchange — trading and
 * balances are entirely off-chain. But it silently stalls deposits, withdrawals, and proof-of-reserves,
 * and previously nothing surfaced that: the errors went only to the server log and the treasury box just
 * vanished. The price feed is the same story: a provider 402 (credits/billing) stopped every oracle pass for
 * 9 days (2026-09-23 → 10-02) with nothing but a log line. This turns those silent failures into loud ones.
 */
import type { Db } from '../db/client.ts';
import { config } from '../config.ts';
import { sendAlert, alertingEnabled, channelsConfigured } from './notify.ts';

export type HealthComponent = 'oracle_ingest' | 'deposit_scan' | 'withdrawal_process' | 'treasury_por';
export type HealthGroup = 'feed' | 'custody';

function custody(label: string) {
  return { label, group: 'custody' as const, threshold: () => config.custodyAlertFailStreak, recentMs: () => config.custodyStaleMs };
}

// Per-component policy. The "recent" window must cover the loop's own cadence: the custody loops pass every
// 30–60s (a 10-minute window), but the oracle passes every ORACLE_REFRESH_MS (6h) — a 10-minute window would
// age every oracle error out before the next pass and the feed could never read as degraded.
const POLICY: Record<HealthComponent, { label: string; group: HealthGroup; threshold: () => number; recentMs: () => number }> = {
  oracle_ingest: {
    label: 'Price feed',
    group: 'feed',
    threshold: () => config.oracleAlertFailStreak,
    recentMs: () => 2 * config.oracleRefreshMs + 30 * 60_000, // one missed pass of slack
  },
  treasury_por: custody('Proof-of-reserves'),
  deposit_scan: custody('Deposit scan'),
  withdrawal_process: custody('Withdrawal processing'),
};

const ALERT_STATE_KEY = 'health_alert_state'; // system_flags row; reason = JSON { components: string[] } — the alerted set

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
  group: HealthGroup;
  monitored: boolean; // counts for alerts + the admin strip: the price feed always, custody only under REAL_FUNDS
  lastOkAt: string | null;
  lastErrAt: string | null;
  lastErr: string | null;
  failStreak: number;
  degraded: boolean; // actively failing past the threshold (streak + a recent error) — the outage signal
  status: HealthStatus; // idle (not running / no data) · ok · warn (running, not succeeding) · bad (degraded)
}

export interface WorkerHealthView {
  custodyActive: boolean; // custody workers only run under REAL_FUNDS; false ⇒ no custody to monitor (play-money)
  rpcHealthy: boolean; // canonical on-chain-read signal: the PoR pass isn't degraded
  feedHealthy: boolean; // the price feed (oracle ingest) isn't degraded
  feedLastOkAt: string | null; // when the oracle last completed a pass
  porLastVerifiedAt: string | null; // when proof-of-reserves last read the chain successfully
  components: ComponentHealth[];
  stalledWithdrawals: number; // queued > withdrawalStallMs (a symptom of the outage; DB-only, no RPC)
  pendingWithdrawals: number;
  alertChannels: string[]; // configured push channels (so the operator can see alerting is actually wired)
}

const ORDER: HealthComponent[] = ['oracle_ingest', 'treasury_por', 'deposit_scan', 'withdrawal_process'];

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
  const t = now();

  const components: ComponentHealth[] = ORDER.map((component) => {
    const r = byId.get(component);
    const policy = POLICY[component];
    const failStreak = r ? Number(r.fail_streak) : 0;
    const lastOkAt = r?.last_ok_at ?? null;
    const lastErrAt = r?.last_err_at ?? null;
    const okMs = r?.ok_epoch != null ? Number(r.ok_epoch) * 1000 : NaN;
    const errMs = r?.err_epoch != null ? Number(r.err_epoch) * 1000 : NaN;
    const okRecent = Number.isFinite(okMs) && t - okMs <= policy.recentMs();
    const errRecent = Number.isFinite(errMs) && t - errMs <= policy.recentMs();
    // A loop is "active" if it ran (ok OR err) within the stale window. One that simply STOPPED running
    // (never started, e.g. withdrawal auto-process off; or an incident that turned a loop off) reads as
    // idle, not alarming — and "degraded" also requires a RECENT error, so a frozen fail_streak on a
    // stopped loop ages out and lets a lingering incident clear instead of getting stuck red forever.
    const degraded = failStreak >= policy.threshold() && errRecent;
    const active = okRecent || errRecent;
    // Failing right now (the last attempt errored — recordOk resets the streak) reads 'warn' even inside the ok
    // window, so a first failed pass shows up immediately instead of staying green until the alert threshold trips.
    const lastAttemptFailed = failStreak > 0 && errRecent;
    const status: HealthStatus = degraded ? 'bad' : !active ? 'idle' : lastAttemptFailed || !okRecent ? 'warn' : 'ok';
    return { component, label: policy.label, group: policy.group, monitored: policy.group === 'feed' || config.realFunds, lastOkAt, lastErrAt, lastErr: r?.last_err ?? null, failStreak, degraded, status };
  });

  const por = components.find((c) => c.component === 'treasury_por')!;
  const feed = components.find((c) => c.component === 'oracle_ingest')!;
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
    feedHealthy: !feed.degraded,
    feedLastOkAt: feed.lastOkAt,
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

// What an outage of each group means for the business, and where to look — the alert's "so what".
const IMPACT: Record<HealthGroup, string> = {
  feed:
    'Impact: card and index prices are NOT updating (markets will halt as stale; index history gets a gap). ' +
    'Trading on already-open markets and customer balances are unaffected.\n' +
    'Likely cause: a price provider is refusing requests (e.g. Scrydex/tcgpricelookup credits or billing — HTTP 402/401) or is down. Check the provider account.',
  custody:
    'Impact: trading & customer balances are UNAFFECTED (off-chain). New deposits are not being credited, ' +
    'withdrawals are paused, and proof-of-reserves is not verifying — until the RPC recovers.\n' +
    'Likely cause: the Solana RPC (SOLANA_RPC_URL / Helius) is unreachable or out of credits. Check the RPC provider.',
};
const GROUP_TITLE: Record<HealthGroup, string> = { feed: 'price feed failing', custody: 'custody incident — Solana RPC unreachable' };
const GROUP_NAME: Record<HealthGroup, string> = { feed: 'price feed', custody: 'custody' };

/**
 * Edge-triggered alerting. Fires ONE incident push when a monitored component first crosses its failure
 * threshold (or escalates to more components), and ONE recovery push when everything clears — never a
 * per-pass alert. State (which components we've alerted on) is persisted in system_flags so it survives
 * restarts. Driven from ONE lease-guarded loop (startHealthAlertLoop) so concurrent callers can't race on
 * that state. Custody components only count when custody is running (REAL_FUNDS). No-op when no channel is set.
 */
export async function checkAndAlert(db: Db, log?: Logger, now: () => number = Date.now): Promise<void> {
  if (!alertingEnabled()) return;
  const view = await getWorkerHealth(db, now);
  const affected = view.components.filter((c) => c.degraded && c.monitored);
  const degraded = affected.map((c) => c.component);
  const prev = await getAlertedSet(db);
  const newlyDegraded = degraded.filter((c) => !prev.has(c));
  const t = now();

  if (degraded.length > 0 && newlyDegraded.length > 0) {
    // Incident start, or escalation (a component degraded that we hadn't alerted on yet).
    const groups = [...new Set(affected.map((c) => c.group))];
    const sections = groups.map((g) => {
      const lines = affected
        .filter((c) => c.group === g)
        .map((c) => `• ${c.label}: ${c.failStreak} consecutive fails, last OK ${ago(c.lastOkAt, t)}${c.lastErr ? ` — ${c.lastErr}` : ''}`);
      const stalled = g === 'custody' ? `\nStalled withdrawals: ${view.stalledWithdrawals} (queued > ${Math.round(config.withdrawalStallMs / 60_000)}m)` : '';
      return `Affected:\n${lines.join('\n')}${stalled}\n\n${IMPACT[g]}`;
    });
    await sendAlert(`🔴 GachaDex ${groups.map((g) => GROUP_TITLE[g]).join(' + ')}`, sections.join('\n\n———\n\n'), log);
    await setAlertedSet(db, degraded);
  } else if (degraded.length === 0 && prev.size > 0) {
    // Full recovery.
    await sendAlert(
      '🟢 GachaDex recovered',
      `All monitored workers are healthy again. Price feed last OK ${ago(view.feedLastOkAt, t)}. ` +
        (view.custodyActive ? `Proof-of-reserves last verified ${ago(view.porLastVerifiedAt, t)}. Pending withdrawals: ${view.pendingWithdrawals}.` : ''),
      log,
    );
    await clearAlertedSet(db);
  } else if (degraded.length !== prev.size) {
    // Partial de-escalation. If a whole GROUP cleared (e.g. the price feed recovered while custody is still down),
    // say so — the feed and custody are unrelated incidents sharing one state. Otherwise just track the set.
    const stillDown = new Set(affected.map((c) => c.group));
    const cleared = [...new Set([...prev].map((c) => POLICY[c as HealthComponent]?.group).filter((g): g is HealthGroup => !!g && !stillDown.has(g)))];
    if (cleared.length) {
      await sendAlert(
        `🟢 GachaDex ${cleared.map((g) => GROUP_NAME[g]).join(' + ')} recovered`,
        `Still affected: ${affected.map((c) => c.label).join(', ')}.`,
        log,
      );
    }
    await setAlertedSet(db, degraded);
  }
}

/**
 * Wrap one monitored worker pass: run it and record ok/err (keeping the existing per-pass logging). Errors
 * are swallowed here exactly as the callers already did (the loop always retries) — this only adds the
 * health bookkeeping. Alerting is NOT done here: it's driven from one lease-guarded loop
 * (startHealthAlertLoop) so callers can't interleave/duplicate alerts. Returns void so it drops into chainLoop.
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
