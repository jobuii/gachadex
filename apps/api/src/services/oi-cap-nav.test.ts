import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// NAV-relative OI cap (Phase 4a). Cap each side at 50% of LP NAV, ON TOP of the static $50k card cap.
// Gate/ADL stay off so we isolate the OI-cap behavior. Each test file runs in its own process.
process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.OI_CAP_NAV_BPS = '5000'; // each side ≤ 50% of NAV

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { ingest } = await import('./oracle.ts');
const { fromPokemontcg } = await import('./providers/pokemontcg.ts');
const { listMarketsWithData } = await import('./markets.ts');
const { creditFaucet } = await import('./faucet.ts');
const { openPosition, getUserPositions } = await import('./engine.ts');
const { lpDeposit } = await import('./lp.ts');
const { reconcile } = await import('./reconcile.ts');
const { usdc } = await import('../money.ts');

await initDb();
const db = await getDb();
await ingest(db, async () => fromPokemontcg([
  { id: 'card-x', name: 'Test', number: '1', images: { small: 'x' }, tcgplayer: { prices: { holofoil: { market: 1000 } } } },
]));
const market = (await listMarketsWithData(db)).find((m) => m.symbol === 'card-x')!;

async function newUser(faucetUsd = 100_000): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1, $2)`, [id, 'pk-' + id.slice(0, 8)]);
  await creditFaucet(db, id, faucetUsd);
  return id;
}
// at the $1000 market price, e6 qty = USD notional × 1000 (1.0 unit = $1000)
const openLong = (u: string, usdNotional: number) =>
  openPosition(db, u, { marketId: market.id, side: 'long', qtyE6: BigInt(usdNotional) * 1_000n, leverage: 5, idempotencyKey: randomUUID() });

test('uncapitalized pool (NAV=0): the NAV-relative cap is 0 → any open is rejected', async () => {
  await assert.rejects(openLong(await newUser(), 1_000), /pool-relative/);
});

test('within the NAV-relative cap is allowed once the pool is funded', async () => {
  await lpDeposit(db, await newUser(20_000), usdc(10_000)); // NAV $10k → per-side navCap = $5k
  const a = await newUser();
  await openLong(a, 4_000); // $4k < $5k navCap (and ≪ the $50k static cap) → allowed
  assert.equal((await getUserPositions(db, a))[0].qtyE6, (4_000_000n).toString());
});

test('cumulative side OI past the NAV-relative cap is rejected — though the static $50k cap is nowhere near', async () => {
  // $4k of long OI already exists; a second trader adding $2k would make $6k > the $5k pool-relative cap
  await assert.rejects(openLong(await newUser(), 2_000), /pool-relative/);
});

test('reconciler stays balanced', async () => {
  const report = await reconcile(db);
  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
});

after(async () => {
  await closeDb();
});
