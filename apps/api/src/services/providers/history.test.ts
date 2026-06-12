import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { getDb, closeDb } = await import('../../db/client.ts');
const { initDb } = await import('../../db/init.ts');
const { upsertCardMarket } = await import('../markets.ts');
const { dailySeedPoints, seedMissingHistory, countMissingHistory } = await import('./history.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

type RowT = import('./tcgpricelookup.ts').TplHistoryRow;
type PointT = import('./tcgpricelookup.ts').TplHistoryPoint;
type ClientT = InstanceType<typeof import('./tcgpricelookup.ts').TcgPriceLookupClient>;

const row = (over: Partial<RowT>): RowT => ({
  source: 'tcgplayer', condition: 'near_mint', grader: null, grade: null,
  price_market: null, price_low: null, price_mid: null, price_high: null,
  avg_1d: null, avg_7d: null, avg_30d: null, ...over,
});

function historyClient(byCard: Record<string, PointT[]>, calls: string[] = []) {
  return {
    calls,
    getCardHistory: async (id: string) => {
      calls.push(id);
      const h = byCard[id];
      if (h === undefined) throw new Error(`simulated provider error for ${id}`);
      return h;
    },
  } as unknown as ClientT & { calls: string[] };
}

test('dailySeedPoints mirrors the live raw chain: liquid spot, thin -> ebay 7d avg, thin no-ebay -> spot', () => {
  const points: PointT[] = [
    { date: '2026-01-01', prices: [row({ price_market: 48.97 })] }, // liquid: spot wins
    { date: '2026-01-02', prices: [row({ price_market: 3.1 }), row({ source: 'ebay', avg_7d: 4.2 })] }, // thin: smoothed
    { date: '2026-01-03', prices: [row({ price_market: 2.5 })] }, // thin, no ebay: spot
    { date: '2026-01-04', prices: [row({ condition: 'lightly_played', price_market: 17.96 })] }, // NM absent: LP fallback
    { date: '2026-01-05', prices: [row({ source: 'ebay', grader: 'psa', grade: '10', condition: null, avg_7d: 900 })] }, // graded-only day: no raw point
    { date: 'not-a-date', prices: [row({ price_market: 10 })] },
  ];
  assert.deepEqual(dailySeedPoints(points), [
    { day: '2026-01-01', priceUsd: 48.97 },
    { day: '2026-01-02', priceUsd: 4.2 },
    { day: '2026-01-03', priceUsd: 2.5 },
    { day: '2026-01-04', priceUsd: 17.96 },
  ]);
});

test('seedMissingHistory seeds unseeded tracked markets, is idempotent, and survives per-market errors', async () => {
  const mkMarket = (n: string, prov: string | null) =>
    upsertCardMarket(db, {
      game: 'mtg', symbol: `seed-${n}`, cardId: `seed-${n}`, displayName: `Seed ${n}`,
      variant: null, imageSmall: null, providerCardId: prov,
    });
  const m1 = await mkMarket('1', 'prov-1');
  const m2 = await mkMarket('2', 'prov-2'); // provider has no history -> sentinel
  const m3 = await mkMarket('3', 'prov-3'); // provider errors -> failed, retried next run
  await mkMarket('4', null); // untracked: never requested

  const history: PointT[] = [
    { date: '2026-05-01', prices: [row({ price_market: 100 })] },
    { date: '2026-05-03', prices: [row({ price_market: 110 })] },
  ];
  const client = historyClient({ 'prov-1': history, 'prov-2': [] });

  assert.equal(await countMissingHistory(db), 3, 'the loop-gate probe counts the same set the sweep works');
  const r1 = await seedMissingHistory(db, client);
  assert.deepEqual(r1, { markets: 3, seeded: 2, points: 2, failed: 1 });
  assert.equal(await countMissingHistory(db), 1, 'only the failed market remains');

  const seeded = await db.query<{ day: string; price_e6: string }>(
    `SELECT day::text AS day, price_e6::text AS price_e6 FROM chart_seed WHERE market_id = $1 ORDER BY day`,
    [m1],
  );
  assert.deepEqual(seeded.rows, [
    { day: '2026-05-01', price_e6: '100000000' },
    { day: '2026-05-03', price_e6: '110000000' },
  ]);
  const sentinel = await db.query<{ price_e6: string }>(`SELECT price_e6::text AS price_e6 FROM chart_seed WHERE market_id = $1`, [m2]);
  assert.deepEqual(sentinel.rows, [{ price_e6: '0' }], 'empty history pins a 0 sentinel so the market is not retried forever');

  // second run: only the failed market is retried; the seeded two are skipped
  const client2 = historyClient({ 'prov-3': history });
  const r2 = await seedMissingHistory(db, client2);
  assert.deepEqual(client2.calls, ['prov-3']);
  assert.deepEqual(r2, { markets: 1, seeded: 1, points: 2, failed: 0 });
  const m3rows = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM chart_seed WHERE market_id = $1`, [m3]);
  assert.equal(m3rows.rows[0].n, '2');
});
