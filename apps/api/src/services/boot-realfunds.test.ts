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
// Search-and-bet on, tcgpricelookup live, but the THREE NAV gates intentionally UNSET — this is the
// exact env that used to throw at config load and crash the boot.
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
  assert.equal(res.json().listingEnabled, false, 'health reports listing off (NAV gates unset) so the web can hide LIST');
});

test('read-only catalogue search stays enabled without the gates; on-demand listing is disabled', async () => {
  // /catalog/search registered → a too-short query is a 400 validation error, NOT a 404 missing route
  const search = await app.inject({ method: 'GET', url: '/catalog/search?q=a&game=pokemon' });
  assert.equal(search.statusCode, 400, 'catalogue search route is registered (read-only, no gate dependency)');
  // /markets/ensure NOT registered → 404 (creating a real-money market needs the NAV gates)
  const ensure = await app.inject({ method: 'POST', url: '/markets/ensure', payload: { providerCardId: 'x' } });
  assert.equal(ensure.statusCode, 404, 'on-demand listing is gated off until the NAV caps are set');
});
