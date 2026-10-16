import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Custody alerting only applies under REAL_FUNDS (custody loops don't run in play-money), so these cases run
// with real funds on + the dummy custody config every real-funds test uses (nothing touches a chain here).
process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.REAL_FUNDS = 'true';
process.env.USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
process.env.TREASURY_PUBKEY = '11111111111111111111111111111111';
process.env.DEPOSIT_MASTER_SEED = 'ab'.repeat(32);
process.env.HOT_WALLET_SECRET = 'unused-in-tests-chain-is-injected';
process.env.ALERT_DISCORD_WEBHOOK_URL = 'https://discord.test/webhook';
process.env.CUSTODY_ALERT_FAIL_STREAK = '2';
process.env.ORACLE_ALERT_FAIL_STREAK = '2';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { recordOk, recordErr, getWorkerHealth, checkAndAlert } = await import('./worker-health.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

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

test('custody components alert when custody is active, with the RPC impact text', async () => {
  assert.equal((await getWorkerHealth(db)).custodyActive, true);
  await recordErr(db, 'treasury_por', new Error('fetch failed https://x.helius-rpc.com/?api-key=SECRET'));
  await recordErr(db, 'treasury_por', new Error('fetch failed https://x.helius-rpc.com/?api-key=SECRET'));
  await checkAndAlert(db);
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /custody incident/i);
  assert.match(sent[0].body, /Solana RPC/);
  assert.ok(!sent[0].body.includes('SECRET'), 'the RPC key never reaches the alert channel');
});

test('escalation: a second group degrading re-alerts with both; full recovery clears once', async () => {
  await recordErr(db, 'oracle_ingest', new Error('scrydex 402'));
  await recordErr(db, 'oracle_ingest', new Error('scrydex 402'));
  await checkAndAlert(db); // incident (price feed)
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /price feed failing/i);

  await recordErr(db, 'deposit_scan', new Error('RPC down'));
  await recordErr(db, 'deposit_scan', new Error('RPC down'));
  await checkAndAlert(db); // escalation (feed + custody)
  assert.equal(sent.length, 2, 'a newly-degraded component escalates the incident');
  assert.match(sent[1].body, /price feed failing \+ custody incident/i);

  await recordOk(db, 'oracle_ingest');
  await checkAndAlert(db); // the feed group cleared while custody is still down → its own recovery push
  assert.equal(sent.length, 3);
  assert.match(sent[2].body, /recovered/i);

  await recordOk(db, 'deposit_scan');
  await checkAndAlert(db); // full recovery
  assert.equal(sent.length, 4);
  assert.match(sent[3].body, /recovered/i);
});

test('a whole group clearing while another is still down gets its own recovery push (review H2)', async () => {
  for (const c of ['oracle_ingest', 'oracle_ingest', 'treasury_por', 'treasury_por'] as const) await recordErr(db, c, new Error('down'));
  await checkAndAlert(db); // incident: feed + custody
  assert.equal(sent.length, 1);
  await recordOk(db, 'oracle_ingest');
  await checkAndAlert(db); // the feed recovered, custody still down
  assert.equal(sent.length, 2);
  assert.match(sent[1].body, /GachaDex price feed recovered/);
  assert.match(sent[1].body, /Still affected: Proof-of-reserves/);
});
