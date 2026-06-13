import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.FUNDING_SKEW_FACTOR_BPS = '30';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { upsertCardMarket } = await import('./markets.ts');
const { accrueFunding } = await import('./funding.ts');
const { setFundingFactor } = await import('./fees.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

// A single long-only position -> longOI>0, shortOI=0 -> skewRatio = 1, so the accrued hourly rate
// equals the funding factor exactly (in bps), letting us prove accrueFunding reads the live knob.
async function longOnlyMarket(): Promise<string> {
  const marketId = await upsertCardMarket(db, {
    game: 'pokemon', symbol: 'fund-' + randomUUID().slice(0, 8), cardId: randomUUID(),
    displayName: 'Funding Test', variant: null, imageSmall: null,
  });
  const uid = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1, $2)`, [uid, 'pk-' + uid.slice(0, 8)]);
  await db.query(
    `INSERT INTO positions(id, user_id, market_id, side, qty_e6, avg_entry_e6, margin_uusdc, leverage_e2, status)
     VALUES($1, $2, $3, 'long', 5000000, 1000000000, 50000000, 500, 'open')`,
    [randomUUID(), uid, marketId],
  );
  return marketId;
}

test('accrueFunding scales the live funding factor by skew (full long skew = the factor in bps)', async () => {
  const marketId = await longOnlyMarket();

  // default factor (30 bps) at full long skew -> 30 bps/hour -> rate_e6 = 30/10000 * 1e6 = 3000
  const a = await accrueFunding(db, marketId);
  assert.equal(a.rateE6, '3000');

  // raise the factor via the admin knob -> the next accrual reflects it immediately (50 bps -> 5000)
  await setFundingFactor(db, 50);
  const b = await accrueFunding(db, marketId);
  assert.equal(b.rateE6, '5000');
  assert.equal(b.cumulativeE6, '8000'); // cumulative index advanced 3000 + 5000

  // setting the factor to 0 disables funding (rate 0; cumulative unchanged)
  await setFundingFactor(db, 0);
  const c = await accrueFunding(db, marketId);
  assert.equal(c.rateE6, '0');
  assert.equal(c.cumulativeE6, '8000');
});
