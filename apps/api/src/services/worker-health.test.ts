import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Hermetic in-memory DB (set BEFORE importing config/db). Configure ONE alert channel + a small failure
// threshold so the edge-triggered alerter is exercisable, and stub-friendly stall/stale windows.
process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.ALERT_DISCORD_WEBHOOK_URL = 'https://discord.test/webhook'; // enables alerting()
process.env.CUSTODY_ALERT_FAIL_STREAK = '2';
process.env.ORACLE_ALERT_FAIL_STREAK = '2';
process.env.ORACLE_REFRESH_MS = String(6 * 60 * 60 * 1000); // 6h cadence → 12.5h 'recent' window
process.env.WITHDRAWAL_STALL_MS = '60000'; // 60s
process.env.CUSTODY_STALE_MS = '600000';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { recordOk, recordErr, getWorkerHealth, checkAndAlert } = await import('./worker-health.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

// Capture outbound alert HTTP so we can assert on incident/recovery transitions without a real network.
const realFetch = global.fetch;
let sent: Array<{ url: string; body: string }> = [];
global.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  sent.push({ url: String(url), body: init && init.body ? String(init.body) : '' });
  return { ok: true, status: 200, text: async () => '' } as unknown as Response;
}) as typeof fetch;
after(() => { global.fetch = realFetch; });

beforeEach(async () => {
  await db.query(`DELETE FROM worker_health`);
  await db.query(`DELETE FROM system_flags WHERE key = 'health_alert_state'`);
  sent = [];
});

test('recordErr increments the streak; recordOk resets it and stamps last_ok_at', async () => {
  await recordErr(db, 'treasury_por', new Error('RPC 429 out of credits'));
  await recordErr(db, 'treasury_por', new Error('RPC 429 out of credits'));
  let h = await getWorkerHealth(db);
  let por = h.components.find((c) => c.component === 'treasury_por')!;
  assert.equal(por.failStreak, 2);
  assert.equal(por.degraded, true); // threshold is 2
  assert.equal(por.lastErr, 'RPC 429 out of credits');
  assert.equal(h.rpcHealthy, false);

  await recordOk(db, 'treasury_por');
  h = await getWorkerHealth(db);
  por = h.components.find((c) => c.component === 'treasury_por')!;
  assert.equal(por.failStreak, 0);
  assert.equal(por.degraded, false);
  assert.ok(por.lastOkAt, 'last_ok_at set after a success');
  assert.equal(h.rpcHealthy, true);
});

test('getWorkerHealth counts stalled withdrawals (DB-only, no RPC)', async () => {
  const uid = 'u-stall';
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1, $2)`, [uid, 'pk-stall']);
  // one freshly queued (not stalled) + one queued 2h ago (stalled)
  await db.query(
    `INSERT INTO withdrawals(id, user_id, dest_address, amount_e6, status, idempotency_key, requested_at)
     VALUES('w-fresh', $1, 'dest', 1000000, 'requested', 'k-fresh', now())`,
    [uid],
  );
  await db.query(
    `INSERT INTO withdrawals(id, user_id, dest_address, amount_e6, status, idempotency_key, requested_at)
     VALUES('w-old', $1, 'dest', 1000000, 'signed', 'k-old', now() - interval '2 hours')`,
    [uid],
  );
  const h = await getWorkerHealth(db);
  assert.equal(h.pendingWithdrawals, 2);
  assert.equal(h.stalledWithdrawals, 1);
});

test('a component with no data reads idle, not degraded/warn (default manual-approval withdrawals)', async () => {
  const h = await getWorkerHealth(db);
  const w = h.components.find((c) => c.component === 'withdrawal_process')!;
  assert.equal(w.status, 'idle');
  assert.equal(w.degraded, false);
});

test('recordErr redacts credential-bearing tokens before storing (no key leaks to alerts/DB)', async () => {
  await recordErr(db, 'treasury_por', new Error('fetch failed https://x.helius-rpc.com/?api-key=SECRET123 econnreset'));
  const h = await getWorkerHealth(db);
  const por = h.components.find((c) => c.component === 'treasury_por')!;
  assert.ok(!(por.lastErr ?? '').includes('SECRET123'), 'the api-key value must be redacted');
  assert.match(por.lastErr ?? '', /api-key=\*\*\*/);
});

test('a degraded component whose loop STOPS ages out of degraded (a stuck incident can clear)', async () => {
  await recordErr(db, 'treasury_por', new Error('RPC down'));
  await recordErr(db, 'treasury_por', new Error('RPC down'));
  let h = await getWorkerHealth(db); // now-ish: recent error → still actively degraded
  assert.equal(h.components.find((c) => c.component === 'treasury_por')!.degraded, true);
  const future = () => Date.now() + 3_600_000; // +1h, well past custodyStaleMs (10m) with no further passes
  h = await getWorkerHealth(db, future);
  const por = h.components.find((c) => c.component === 'treasury_por')!;
  assert.equal(por.degraded, false, 'a stopped loop is no longer "actively" degraded');
  assert.equal(por.status, 'idle');
});

test('checkAndAlert is edge-triggered on the price feed: incident once, no repeat, then recovery', async () => {
  // Below threshold → no alert.
  await recordErr(db, 'oracle_ingest', new Error('scrydex 402 on /pokemon/v1/cards'));
  await checkAndAlert(db);
  assert.equal(sent.length, 0, 'one failure (< threshold) does not alert');

  // Cross the threshold → exactly one incident alert, worded as a price-feed outage (not custody).
  await recordErr(db, 'oracle_ingest', new Error('scrydex 402 on /pokemon/v1/cards'));
  await checkAndAlert(db);
  assert.equal(sent.length, 1, 'crossing the threshold fires one incident alert');
  assert.match(sent[0].body, /price feed failing/i);
  assert.match(sent[0].body, /scrydex 402/);
  assert.doesNotMatch(sent[0].body, /Solana RPC/);

  // Still degraded on the next pass → NO repeat alert.
  await recordErr(db, 'oracle_ingest', new Error('scrydex 402'));
  await checkAndAlert(db);
  assert.equal(sent.length, 1, 'a persisting incident does not re-alert every pass');

  // Recovery → exactly one recovery alert.
  await recordOk(db, 'oracle_ingest');
  await checkAndAlert(db);
  assert.equal(sent.length, 2, 'clearing fires one recovery alert');
  assert.match(sent[1].body, /recovered/i);
});

test('the price feed stays degraded across its own 6h cadence (a 10-minute custody window would hide it)', async () => {
  await recordErr(db, 'oracle_ingest', new Error('scrydex 402'));
  await recordErr(db, 'oracle_ingest', new Error('scrydex 402'));
  const threeHoursLater = () => Date.now() + 3 * 3_600_000;
  let h = await getWorkerHealth(db, threeHoursLater);
  assert.equal(h.feedHealthy, false, 'an error 3h ago (mid-cadence) is still recent for a 6h loop');
  assert.equal(h.components.find((c) => c.component === 'oracle_ingest')!.status, 'bad');
  const dayLater = () => Date.now() + 26 * 3_600_000; // past 2×6h + 30m with no further pass → stopped, not failing
  h = await getWorkerHealth(db, dayLater);
  assert.equal(h.feedHealthy, true);
});

test('custody components never alert while custody is inactive (play-money / REAL_FUNDS off)', async () => {
  await recordErr(db, 'treasury_por', new Error('RPC down'));
  await recordErr(db, 'treasury_por', new Error('RPC down'));
  const h = await getWorkerHealth(db);
  assert.equal(h.custodyActive, false);
  assert.equal(h.components.find((c) => c.component === 'treasury_por')!.degraded, true, 'still reported in the view');
  await checkAndAlert(db);
  assert.equal(sent.length, 0, 'but no custody push when custody is not running');
});

test('one failed pass shows as warn immediately, not green (review H8)', async () => {
  await recordOk(db, 'oracle_ingest');
  await recordErr(db, 'oracle_ingest', new Error('scrydex 402'));
  const c = (await getWorkerHealth(db)).components.find((x) => x.component === 'oracle_ingest')!;
  assert.equal(c.degraded, false, 'below the alert threshold');
  assert.equal(c.status, 'warn');
});
