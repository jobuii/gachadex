import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// Regression guard for the REAL_FUNDS=true startup path, which the rest of the suite never exercises
// (every other test boots in play money, so config assertions guarded by `config.realFunds` are
// skipped). A search-and-bet boot assertion once crashed production here while all tests passed —
// this boots the server under a production-like real-funds env and proves it comes up.
process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.RATE_LIMIT_DISABLED = 'true';
// Real-funds custody config (devnet RPC + a non-mainnet mint keep the mainnet gate from firing).
process.env.REAL_FUNDS = 'true';
process.env.SOLANA_RPC_URL = 'https://api.devnet.solana.com';
process.env.USDC_MINT = 'Fake1111111111111111111111111111111111111111';
process.env.TREASURY_PUBKEY = 'Fake2222222222222222222222222222222222222222';
process.env.DEPOSIT_MASTER_SEED = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
process.env.HOT_WALLET_SECRET = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
// Search-and-bet on, tcgpricelookup live; the THREE NAV gates intentionally UNSET — this was the exact
// env that once threw at config load and crashed the boot. Since 2026-06-22 it's also the env where
// on-demand listing is ENABLED, because listing no longer depends on the NAV caps (operator decision).
process.env.ORACLE_PRIMARY = 'tcgpricelookup';
process.env.TCGPRICELOOKUP_API_KEY = 'dummy';
delete process.env.MAX_PNL_FACTOR_BPS;
delete process.env.ADL_PNL_FACTOR_BPS;
delete process.env.OI_CAP_NAV_BPS;

const { buildServer } = await import('../server.ts');
const app = await buildServer(); // throws here if config load / route registration crashes under real funds
after(async () => {
  await app.close();
});

test('REAL_FUNDS boot with search-and-bet on but NAV gates unset: server comes up, /health is ok', async () => {
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
  assert.equal(res.json().realFunds, true);
  assert.equal(res.json().listingEnabled, true, 'health reports listing ON — it follows catalogue search now, not the NAV gates');
});

test('catalogue search and on-demand listing are both enabled without the NAV gates', async () => {
  // /catalog/search registered but authenticated → an anonymous request is 401, NOT a 404 missing route
  const search = await app.inject({ method: 'GET', url: '/catalog/search?q=ab&game=pokemon' });
  assert.equal(search.statusCode, 401, 'catalogue search route is registered (no NAV-gate dependency) and requires sign-in');
  // /markets/ensure now registered too (listing no longer gated on the NAV caps) → auth-gated 401, not 404
  const ensure = await app.inject({ method: 'POST', url: '/markets/ensure', payload: { providerCardId: 'x' } });
  assert.equal(ensure.statusCode, 401, 'on-demand listing route is registered (NAV-gate requirement removed) and requires sign-in');
});
