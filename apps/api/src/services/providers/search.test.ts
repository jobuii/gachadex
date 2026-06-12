import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { getDb, closeDb } = await import('../../db/client.ts');
const { initDb } = await import('../../db/init.ts');
const { upsertCardMarket } = await import('../markets.ts');
const { retireDeadMarkets } = await import('./discovery.ts');
const { searchCatalog, ensureMarketFromCard, isListable, minQtyForPrice, clearSearchCache, MIN_LIST_PRICE_USD } =
  await import('./search.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

type TplCardT = import('./tcgpricelookup.ts').TplCard;
type ClientT = InstanceType<typeof import('./tcgpricelookup.ts').TcgPriceLookupClient>;

const card = (id: string, opts: { spot?: number; ebay7d?: number; tid?: number | null; game?: string } = {}): TplCardT => ({
  id,
  tcgplayer_id: opts.tid === undefined ? null : opts.tid,
  name: `Card ${id}`,
  number: '7/100',
  rarity: 'Rare',
  variant: 'Standard',
  image_url: `img/${id}`,
  updated_at: '2026-06-12T12:00:00Z',
  set: { slug: 's', name: 'Test Set' },
  game: { slug: opts.game ?? 'mtg', name: 'Magic' },
  prices: {
    raw: {
      near_mint: {
        tcgplayer: opts.spot != null ? { market: opts.spot } : {},
        ebay: opts.ebay7d != null ? { avg_7d: opts.ebay7d } : {},
      },
    },
  },
});

function fakeClient(catalog: TplCardT[], counters = { search: 0, get: 0 }) {
  return {
    counters,
    searchCards: async ({ q }: { q?: string }) => {
      counters.search++;
      const data = catalog.filter((c) => c.name.toLowerCase().includes((q ?? '').toLowerCase()));
      return { data, total: data.length, limit: 20, offset: 0 };
    },
    getCard: async (id: string) => {
      counters.get++;
      return catalog.find((c) => c.id === id) ?? null;
    },
    getCardHistory: async () => [],
  } as unknown as ClientT & { counters: typeof counters };
}

test('isListable: $10 floor + eBay agreement within 25%, rejects one-sided cards', () => {
  assert.equal(isListable(card('a', { spot: 48.97, ebay7d: 50 })), true);
  assert.equal(isListable(card('b', { spot: 9.99, ebay7d: 10 })), false, 'below the floor');
  assert.equal(isListable(card('c', { spot: 50 })), false, 'no eBay corroboration');
  assert.equal(isListable(card('d', { spot: 50, ebay7d: 20 })), false, 'eBay disagrees by 60%');
  assert.equal(isListable(card('e', { ebay7d: 50 })), false, 'no TCGplayer market price');
  assert.equal(MIN_LIST_PRICE_USD, 10);
});

test('minQtyForPrice: ~$1 minimum notional, rounded up to the qty step', () => {
  assert.equal(minQtyForPrice(10_000_000n), 100_000n); // $10 card -> 0.1 units
  assert.equal(minQtyForPrice(100_000_000n), 10_000n); // $100 card -> step floor
  assert.equal(minQtyForPrice(33_000_000n), 40_000n); // $33 -> ceil(0.0303) to step = 0.04
  assert.equal(minQtyForPrice(0n), 10_000n);
});

test('searchCatalog caches the provider call and joins existing markets fresh on every call', async () => {
  clearSearchCache();
  const existingId = await upsertCardMarket(db, {
    game: 'mtg', symbol: 'cat-existing', cardId: 'cat-existing', displayName: 'Existing', variant: null,
    imageSmall: null, providerCardId: 'prov-existing',
  });
  const twinHolder = await upsertCardMarket(db, {
    game: 'mtg', symbol: 'cat-twin', cardId: 'cat-twin', displayName: 'Twin', variant: null,
    imageSmall: null, providerCardId: 'prov-twin-other', tcgplayerId: 424242,
  });
  const catalog = [
    card('prov-existing', { spot: 50, ebay7d: 52 }),
    card('prov-variant', { spot: 60, ebay7d: 58, tid: 424242 }), // different printing, same product
    card('prov-new', { spot: 30, ebay7d: 31 }),
    card('prov-cheap', { spot: 3, ebay7d: 3 }),
  ];
  const client = fakeClient(catalog);

  const r1 = await searchCatalog(db, client, 'Card', 'mtg');
  assert.equal(client.counters.search, 1);
  const by = new Map(r1.map((r) => [r.providerCardId, r]));
  assert.equal(by.get('prov-existing')?.marketId, existingId, 'existing market joined by provider id');
  assert.equal(by.get('prov-variant')?.marketId, twinHolder, 'printing variant joined to the canonical market');
  assert.equal(by.get('prov-new')?.marketId, null);
  assert.equal(by.get('prov-new')?.listable, true);
  assert.equal(by.get('prov-cheap')?.listable, false);

  // second identical search: served from cache (no provider call) but the market join is LIVE
  const newId = await upsertCardMarket(db, {
    game: 'mtg', symbol: 'cat-new', cardId: 'cat-new', displayName: 'New', variant: null,
    imageSmall: null, providerCardId: 'prov-new',
  });
  const r2 = await searchCatalog(db, client, 'Card', 'mtg');
  assert.equal(client.counters.search, 1, 'cache hit — no second provider request');
  assert.equal(r2.find((r) => r.providerCardId === 'prov-new')?.marketId, newId, 'join reflects the new market');
});

test('ensureMarketFromCard: creates once (idempotent), with first print, mark, and min-notional', async () => {
  const catalog = [card('prov-ensure', { spot: 20, ebay7d: 21, tid: 777001 })];
  const client = fakeClient(catalog);

  const first = await ensureMarketFromCard(db, client, 'prov-ensure');
  assert.equal(first.created, true);
  const m = await db.query<{ symbol: string; game: string; featured: boolean; status: string; min_qty: string }>(
    `SELECT symbol, game, featured, status, min_qty_e6::text AS min_qty FROM markets WHERE id = $1`,
    [first.marketId],
  );
  assert.equal(m.rows[0].symbol, 'mtg:prov-ensure', 'game-namespaced symbol');
  assert.equal(m.rows[0].featured, false, 'long-tail: never an index constituent');
  assert.equal(m.rows[0].min_qty, '50000', '~$21 card -> 0.05 units = $1 min notional');
  const print = await db.query<{ v: string }>(
    `SELECT index_price_e6::text AS v FROM oracle_prices WHERE market_id = $1 AND is_accepted`,
    [first.marketId],
  );
  // $20 NM spot is under the $25 liquidity threshold -> the eBay 7d average ($21) prices the print
  assert.equal(print.rows[0]?.v, '21000000', 'first print uses the smoothed-chain price');
  const mark = await db.query(`SELECT 1 FROM marks WHERE market_id = $1`, [first.marketId]);
  assert.equal(mark.rows.length, 1, 'tradeable immediately — mark exists');

  const again = await ensureMarketFromCard(db, client, 'prov-ensure');
  assert.deepEqual(again, { marketId: first.marketId, created: false });

  // a different printing of the same physical product (same tcgplayer id) maps to the SAME market
  const variant = await ensureMarketFromCard(db, fakeClient([card('prov-ensure-alt', { spot: 22, ebay7d: 22, tid: 777001 })]), 'prov-ensure-alt');
  assert.deepEqual(variant, { marketId: first.marketId, created: false });

  // a retired market comes BACK on re-ensure, repriced on a FRESH mark (never the stale one)
  await db.query(
    `UPDATE markets SET status = 'delisted', tradeable = false, created_at = now() - interval '60 days' WHERE id = $1`,
    [first.marketId],
  );
  const revived = await ensureMarketFromCard(db, client, 'prov-ensure');
  assert.deepEqual(revived, { marketId: first.marketId, created: false });
  const back = await db.query<{ status: string; tradeable: boolean; fresh: boolean }>(
    `SELECT status, tradeable, created_at > now() - interval '1 day' AS fresh FROM markets WHERE id = $1`,
    [first.marketId],
  );
  assert.deepEqual(back.rows[0], { status: 'active', tradeable: true, fresh: true });
  // a mark newer than the (reset) activation exists — so the engine freshness gate lets opens through
  const mk = await db.query(
    `SELECT 1 FROM marks WHERE market_id = $1 AND computed_at >= (SELECT created_at FROM markets WHERE id = $1)`,
    [first.marketId],
  );
  assert.equal(mk.rows.length >= 1, true, 'revival printed a fresh mark — no stale-price open window');
});

test('ensureMarketFromCard rejects unlistable cards and unknown ids', async () => {
  await assert.rejects(
    ensureMarketFromCard(db, fakeClient([card('prov-thin', { spot: 4, ebay7d: 4 })]), 'prov-thin'),
    /not listable/,
  );
  await assert.rejects(ensureMarketFromCard(db, fakeClient([]), 'prov-missing'), /card not found/);
  await assert.rejects(
    ensureMarketFromCard(db, fakeClient([card('prov-og', { spot: 50, ebay7d: 50, game: 'lorcana' })]), 'prov-og'),
    /unsupported game/,
  );
});

test('retireDeadMarkets: 30d-dead long-tail only — featured, young, and held markets survive', async () => {
  const mk = (sym: string, featured: boolean) =>
    upsertCardMarket(db, {
      game: 'mtg', symbol: sym, cardId: sym, displayName: sym, variant: null, imageSmall: null,
      providerCardId: `prov-${sym}`, featured,
    });
  const dead = await mk('ret-dead', false);
  const young = await mk('ret-young', false);
  const feat = await mk('ret-featured', true);
  const held = await mk('ret-held', false);
  // age the candidates past the 30-day line
  await db.query(`UPDATE markets SET created_at = now() - interval '40 days' WHERE id = ANY($1)`, [[dead, feat, held]]);
  // an open position pins `held`
  const uid = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1, $2)`, [uid, 'pk-' + uid.slice(0, 8)]);
  await db.query(
    `INSERT INTO positions(id, user_id, market_id, side, qty_e6, avg_entry_e6, margin_uusdc, leverage_e2, status)
     VALUES($1, $2, $3, 'long', 10000, 1000000, 1000000, 100, 'open')`,
    [randomUUID(), uid, held],
  );

  const retired = await retireDeadMarkets(db, 30);
  assert.deepEqual(retired.sort(), [dead].sort(), 'only the dead long-tail market retired');
  const rows = await db.query<{ id: string; status: string; tradeable: boolean }>(
    `SELECT id, status, tradeable FROM markets WHERE id = ANY($1)`,
    [[dead, young, feat, held]],
  );
  const byId = new Map(rows.rows.map((r) => [r.id, r]));
  assert.equal(byId.get(dead)?.status, 'delisted');
  assert.equal(byId.get(dead)?.tradeable, false);
  assert.equal(byId.get(young)?.status, 'active');
  assert.equal(byId.get(feat)?.status, 'active');
  assert.equal(byId.get(held)?.status, 'active');
});
