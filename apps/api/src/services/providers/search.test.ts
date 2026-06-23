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
const { searchCatalog, ensureMarketFromCard, isListable, clearSearchCache, MIN_LIST_PRICE_USD } =
  await import('./search.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

const FX = async () => 1; // hermetic FX stub (only JPY cards use it; these fixtures are USD)

type TplCardT = import('./tcgpricelookup.ts').TplCard;
type ClientT = InstanceType<typeof import('./tcgpricelookup.ts').TcgPriceLookupClient>;
type ScrydexCardT = import('./scrydex.ts').ScrydexCard;
type ScrydexClientT = InstanceType<typeof import('./scrydex.ts').ScrydexClient>;

// --- tcgpl fixtures (One Piece path) ---
const tplCard = (id: string, opts: { spot?: number; ebay7d?: number; tid?: number | null; game?: string } = {}): TplCardT => ({
  id,
  tcgplayer_id: opts.tid === undefined ? null : opts.tid,
  name: `Card ${id}`,
  number: '7/100',
  rarity: 'Rare',
  variant: 'Standard',
  image_url: `img/${id}`,
  updated_at: '2026-06-12T12:00:00Z',
  set: { slug: 's', name: 'Test Set' },
  game: { slug: opts.game ?? 'onepiece', name: 'One Piece' },
  prices: { raw: { near_mint: { tcgplayer: opts.spot != null ? { market: opts.spot } : {}, ebay: opts.ebay7d != null ? { avg_7d: opts.ebay7d } : {} } } },
});

function fakeTpl(catalog: TplCardT[], counters = { search: 0, get: 0 }) {
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

// --- scrydex fixtures (Pokémon/MTG path). Price lives in variants[].prices[]; the tcgplayer product_id
//     in variants[].marketplaces[] is the join key. A card with no priced+product-id'd variant is unlistable. ---
const sxCard = (
  id: string,
  opts: { market?: number; tid?: number; low?: number; high?: number; name?: string; currency?: string } = {},
): ScrydexCardT => ({
  id,
  name: opts.name ?? `Card ${id}`,
  number: '7/100',
  rarity: 'Rare',
  language_code: 'EN',
  images: [{ type: 'front', small: `img/${id}`, large: `img/${id}-lg` }],
  expansion: { id: 'exp-1', name: 'Test Expansion' },
  variants:
    opts.market != null && opts.tid != null
      ? [
          {
            name: 'holofoil',
            marketplaces: [{ name: 'tcgplayer', product_id: opts.tid }],
            prices: [
              {
                type: 'raw',
                condition: 'NM',
                market: opts.market,
                low: opts.low ?? opts.market * 0.9,
                high: opts.high ?? opts.market * 1.1,
                currency: opts.currency ?? 'USD',
              },
            ],
          },
        ]
      : [],
});

function fakeScrydex(catalog: ScrydexCardT[], counters = { search: 0, get: 0 }) {
  return {
    counters,
    searchCards: async (_slug: string, { q }: { q?: string }) => {
      counters.search++;
      const data = catalog.filter((c) => (c.name ?? '').toLowerCase().includes((q ?? '').toLowerCase()));
      return { data, total_count: data.length, page: 1, page_size: 20 };
    },
    getCard: async (_slug: string, id: string) => {
      counters.get++;
      return catalog.find((c) => c.id === id) ?? null;
    },
  } as unknown as ScrydexClientT & { counters: typeof counters };
}

const clientsOf = (o: { tcgpl?: ReturnType<typeof fakeTpl>; scrydex?: ReturnType<typeof fakeScrydex> } = {}) => ({
  scrydex: (o.scrydex ?? fakeScrydex([])) as ScrydexClientT,
  tcgpl: (o.tcgpl ?? fakeTpl([])) as ClientT,
});

test('isListable: $10 floor + eBay agreement within 25%, rejects one-sided cards', () => {
  assert.equal(isListable(tplCard('a', { spot: 48.97, ebay7d: 50 })), true);
  assert.equal(isListable(tplCard('b', { spot: 9.99, ebay7d: 10 })), false, 'below the floor');
  assert.equal(isListable(tplCard('c', { spot: 50 })), false, 'no eBay corroboration');
  assert.equal(isListable(tplCard('d', { spot: 50, ebay7d: 20 })), false, 'eBay disagrees by 60%');
  assert.equal(isListable(tplCard('e', { ebay7d: 50 })), false, 'no TCGplayer market price');
  assert.equal(MIN_LIST_PRICE_USD, 10);
});

// ===========================================================================
// One Piece (tcgpl) path — the original behaviour, unchanged.
// ===========================================================================

test('[tcgpl/OP] searchCatalog caches the provider call and joins existing markets fresh on every call', async () => {
  clearSearchCache();
  const existingId = await upsertCardMarket(db, {
    game: 'onepiece', symbol: 'op-existing', cardId: 'op-existing', displayName: 'Existing', variant: null,
    imageSmall: null, providerCardId: 'prov-existing',
  });
  const twinHolder = await upsertCardMarket(db, {
    game: 'onepiece', symbol: 'op-twin', cardId: 'op-twin', displayName: 'Twin', variant: null,
    imageSmall: null, providerCardId: 'prov-twin-other', tcgplayerId: 424242,
  });
  const catalog = [
    tplCard('prov-existing', { spot: 50, ebay7d: 52 }),
    tplCard('prov-variant', { spot: 60, ebay7d: 58, tid: 424242 }),
    tplCard('prov-new', { spot: 30, ebay7d: 31 }),
    tplCard('prov-cheap', { spot: 3, ebay7d: 3 }),
  ];
  const tcgpl = fakeTpl(catalog);
  const scrydex = fakeScrydex([]);

  const r1 = await searchCatalog(db, clientsOf({ tcgpl, scrydex }), 'Card', 'onepiece', FX);
  assert.equal(tcgpl.counters.search, 1, 'One Piece routes to tcgpl');
  assert.equal(scrydex.counters.search, 0, 'scrydex untouched for One Piece');
  const by = new Map(r1.map((r) => [r.providerCardId, r]));
  assert.equal(by.get('prov-existing')?.marketId, existingId, 'existing market joined by provider id');
  assert.equal(by.get('prov-variant')?.marketId, twinHolder, 'printing variant joined to the canonical market');
  assert.equal(by.get('prov-new')?.marketId, null);
  assert.equal(by.get('prov-new')?.listable, true);
  assert.equal(by.get('prov-cheap')?.listable, false);

  const newId = await upsertCardMarket(db, {
    game: 'onepiece', symbol: 'op-new', cardId: 'op-new', displayName: 'New', variant: null,
    imageSmall: null, providerCardId: 'prov-new',
  });
  const r2 = await searchCatalog(db, clientsOf({ tcgpl, scrydex }), 'Card', 'onepiece', FX);
  assert.equal(tcgpl.counters.search, 1, 'cache hit — no second provider request');
  assert.equal(r2.find((r) => r.providerCardId === 'prov-new')?.marketId, newId, 'join reflects the new market');
});

test('[tcgpl/OP] ensureMarketFromCard: idempotent create, variant dedup, revival on a fresh mark', async () => {
  const catalog = [tplCard('prov-ensure', { spot: 20, ebay7d: 21, tid: 777001 })];
  const first = await ensureMarketFromCard(db, clientsOf({ tcgpl: fakeTpl(catalog) }), 'prov-ensure', 'onepiece', FX);
  assert.equal(first.created, true);
  const m = await db.query<{ symbol: string; featured: boolean }>(`SELECT symbol, featured FROM markets WHERE id = $1`, [first.marketId]);
  assert.equal(m.rows[0].symbol, 'onepiece:prov-ensure', 'game-namespaced symbol');
  assert.equal(m.rows[0].featured, false, 'long-tail: never an index constituent');
  const mark = await db.query(`SELECT 1 FROM marks WHERE market_id = $1`, [first.marketId]);
  assert.equal(mark.rows.length, 1, 'tradeable immediately — mark exists');

  const again = await ensureMarketFromCard(db, clientsOf({ tcgpl: fakeTpl(catalog) }), 'prov-ensure', 'onepiece', FX);
  assert.deepEqual(again, { marketId: first.marketId, created: false });

  const variant = await ensureMarketFromCard(db, clientsOf({ tcgpl: fakeTpl([tplCard('prov-ensure-alt', { spot: 22, ebay7d: 22, tid: 777001 })]) }), 'prov-ensure-alt', 'onepiece', FX);
  assert.deepEqual(variant, { marketId: first.marketId, created: false }, 'same tcgplayer_id → same market');

  await db.query(`UPDATE markets SET status = 'delisted', tradeable = false, created_at = now() - interval '60 days' WHERE id = $1`, [first.marketId]);
  const revived = await ensureMarketFromCard(db, clientsOf({ tcgpl: fakeTpl(catalog) }), 'prov-ensure', 'onepiece', FX);
  assert.deepEqual(revived, { marketId: first.marketId, created: false });
  const back = await db.query<{ status: string; fresh: boolean }>(
    `SELECT status, created_at > now() - interval '1 day' AS fresh FROM markets WHERE id = $1`,
    [first.marketId],
  );
  assert.deepEqual(back.rows[0], { status: 'active', fresh: true });
});

test('[tcgpl/OP] ensureMarketFromCard rejects unlistable + unknown ids', async () => {
  await assert.rejects(ensureMarketFromCard(db, clientsOf({ tcgpl: fakeTpl([tplCard('prov-thin', { spot: 4, ebay7d: 4 })]) }), 'prov-thin', 'onepiece', FX), /not listable/);
  await assert.rejects(ensureMarketFromCard(db, clientsOf({ tcgpl: fakeTpl([]) }), 'prov-missing', 'onepiece', FX), /card not found/);
});

// ===========================================================================
// Pokémon/MTG (scrydex) path — the primary provider for the games it covers.
// ===========================================================================

test('[scrydex] searchCatalog routes Pokémon to Scrydex, maps variant price, joins by scrydex_card_id + tcgplayer_id', async () => {
  clearSearchCache();
  const existingId = await upsertCardMarket(db, {
    game: 'pokemon', symbol: 'pk-existing', cardId: 'pk-existing', displayName: 'Existing', variant: null, imageSmall: null,
  });
  await db.query(`UPDATE markets SET scrydex_card_id = $1 WHERE id = $2`, ['sx-existing', existingId]);
  const twinHolder = await upsertCardMarket(db, {
    game: 'pokemon', symbol: 'pk-twin', cardId: 'pk-twin', displayName: 'Twin', variant: null, imageSmall: null,
    providerCardId: 'prov-twin', tcgplayerId: 555001,
  });
  const catalog = [
    sxCard('sx-existing', { market: 50, tid: 111 }),
    sxCard('sx-twin', { market: 60, tid: 555001 }), // shares the canonical tcgplayer_id
    sxCard('sx-new', { market: 30, tid: 222 }),
    sxCard('sx-cheap', { market: 4, tid: 333 }),
    sxCard('sx-noprice', {}), // no priced variant → unlistable, unmatched
  ];
  const scrydex = fakeScrydex(catalog);
  const tcgpl = fakeTpl([]);

  const r = await searchCatalog(db, clientsOf({ scrydex, tcgpl }), 'Card', 'pokemon', FX);
  assert.equal(scrydex.counters.search, 1, 'Pokémon routes to scrydex');
  assert.equal(tcgpl.counters.search, 0, 'tcgpl untouched for Pokémon');
  const by = new Map(r.map((x) => [x.providerCardId, x]));
  assert.equal(by.get('sx-existing')?.marketId, existingId, 'joined by scrydex_card_id');
  assert.equal(by.get('sx-existing')?.priceUsd, 50, 'price from the variant market');
  assert.equal(by.get('sx-twin')?.marketId, twinHolder, 'joined by canonical tcgplayer_id');
  assert.equal(by.get('sx-new')?.marketId, null);
  assert.equal(by.get('sx-new')?.listable, true);
  assert.equal(by.get('sx-cheap')?.listable, false, 'below the $10 floor');
  assert.equal(by.get('sx-noprice')?.listable, false, 'no tcgplayer-priced variant');
});

test('[scrydex] ensureMarketFromCard: creates with scrydex_card_id + tcgplayer_id (null provider_card_id), idempotent, dedup, revival', async () => {
  const c = sxCard('sx-ensure', { market: 25, tid: 888001 });
  const first = await ensureMarketFromCard(db, clientsOf({ scrydex: fakeScrydex([c]) }), 'sx-ensure', 'pokemon', FX);
  assert.equal(first.created, true);
  const m = await db.query<{ symbol: string; sid: string | null; pid: string | null; tid: string | null; featured: boolean }>(
    `SELECT symbol, scrydex_card_id AS sid, provider_card_id AS pid, tcgplayer_id::text AS tid, featured FROM markets WHERE id = $1`,
    [first.marketId],
  );
  assert.equal(m.rows[0].symbol, 'pokemon:sx-ensure', 'game-namespaced symbol');
  assert.equal(m.rows[0].sid, 'sx-ensure', 'scrydex_card_id stamped so the oracle anchors it on Scrydex');
  assert.equal(m.rows[0].pid, null, 'no tcgpl provider_card_id for a scrydex-listed market');
  assert.equal(m.rows[0].tid, '888001', 'tcgplayer_id set so extractRaw can price the variant');
  assert.equal(m.rows[0].featured, false);
  const mark = await db.query(`SELECT 1 FROM marks WHERE market_id = $1`, [first.marketId]);
  assert.equal(mark.rows.length, 1, 'tradeable immediately — a fresh mark exists');

  const again = await ensureMarketFromCard(db, clientsOf({ scrydex: fakeScrydex([c]) }), 'sx-ensure', 'pokemon', FX);
  assert.deepEqual(again, { marketId: first.marketId, created: false }, 'idempotent on scrydex_card_id');

  const twin = sxCard('sx-ensure-alt', { market: 26, tid: 888001 }); // same tcgplayer_id, different scrydex id
  const variant = await ensureMarketFromCard(db, clientsOf({ scrydex: fakeScrydex([twin]) }), 'sx-ensure-alt', 'pokemon', FX);
  assert.deepEqual(variant, { marketId: first.marketId, created: false }, 'same tcgplayer_id → same market');

  await db.query(`UPDATE markets SET status = 'delisted', tradeable = false, created_at = now() - interval '60 days' WHERE id = $1`, [first.marketId]);
  const revived = await ensureMarketFromCard(db, clientsOf({ scrydex: fakeScrydex([c]) }), 'sx-ensure', 'pokemon', FX);
  assert.deepEqual(revived, { marketId: first.marketId, created: false });
  const back = await db.query<{ status: string; fresh: boolean }>(
    `SELECT status, created_at > now() - interval '1 day' AS fresh FROM markets WHERE id = $1`,
    [first.marketId],
  );
  assert.deepEqual(back.rows[0], { status: 'active', fresh: true }, 'revived on a fresh activation marker');
});

test('[scrydex] ranks variants in USD — a JPY printing\'s larger native number does not win the listing', async () => {
  clearSearchCache();
  const FX_JPY = async () => 0.0067; // ≈ USD per 1 JPY
  // USD $500 printing vs JP ¥8000 (≈ $53.6) printing. The native magnitude 8000 > 500 would (pre-fix)
  // wrongly pick the cheaper Japanese variant; ranking in USD must pick the $500 English printing.
  const mixed = {
    id: 'sx-mixed', name: 'Card sx-mixed', number: '1', rarity: 'Rare', language_code: 'EN',
    images: [{ type: 'front', small: 'img/sx-mixed' }], expansion: { id: 'exp-1', name: 'Exp' },
    variants: [
      { name: 'usd', marketplaces: [{ name: 'tcgplayer', product_id: 1001 }], prices: [{ type: 'raw', condition: 'NM', market: 500, low: 450, high: 550, currency: 'USD' }] },
      { name: 'jp', marketplaces: [{ name: 'tcgplayer', product_id: 1002 }], prices: [{ type: 'raw', condition: 'NM', market: 8000, low: 7200, high: 8800, currency: 'JPY' }] },
    ],
  } as ScrydexCardT;
  const r = await searchCatalog(db, clientsOf({ scrydex: fakeScrydex([mixed]) }), 'Card', 'pokemon', FX_JPY);
  assert.equal(r.find((x) => x.providerCardId === 'sx-mixed')?.priceUsd, 500, 'USD printing wins (ranked in USD, not native ¥8000)');
  const e = await ensureMarketFromCard(db, clientsOf({ scrydex: fakeScrydex([mixed]) }), 'sx-mixed', 'pokemon', FX_JPY);
  const m = await db.query<{ tid: string | null }>(`SELECT tcgplayer_id::text AS tid FROM markets WHERE id = $1`, [e.marketId]);
  assert.equal(m.rows[0].tid, '1001', 'listed on the USD printing, not the cheaper JPY one');
});

test('[scrydex] ensureMarketFromCard rejects cheap/unpriced cards + unknown ids', async () => {
  await assert.rejects(ensureMarketFromCard(db, clientsOf({ scrydex: fakeScrydex([sxCard('sx-thin', { market: 4, tid: 901 })]) }), 'sx-thin', 'pokemon', FX), /not listable/);
  await assert.rejects(ensureMarketFromCard(db, clientsOf({ scrydex: fakeScrydex([sxCard('sx-bare', {})]) }), 'sx-bare', 'pokemon', FX), /not listable/);
  await assert.rejects(ensureMarketFromCard(db, clientsOf({ scrydex: fakeScrydex([]) }), 'sx-missing', 'pokemon', FX), /card not found/);
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
  await db.query(`UPDATE markets SET created_at = now() - interval '40 days' WHERE id = ANY($1)`, [[dead, feat, held]]);
  const uid = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1, $2)`, [uid, 'pk-' + uid.slice(0, 8)]);
  await db.query(
    `INSERT INTO positions(id, user_id, market_id, side, qty_e6, avg_entry_e6, margin_uusdc, leverage_e2, status)
     VALUES($1, $2, $3, 'long', 10000, 1000000, 1000000, 100, 'open')`,
    [randomUUID(), uid, held],
  );

  const retired = await retireDeadMarkets(db, 30);
  assert.deepEqual(retired.sort(), [dead].sort(), 'only the dead long-tail market retired');
  const rows = await db.query<{ id: string; status: string }>(`SELECT id, status FROM markets WHERE id = ANY($1)`, [[dead, young, feat, held]]);
  const byId = new Map(rows.rows.map((r) => [r.id, r.status]));
  assert.equal(byId.get(dead), 'delisted');
  assert.equal(byId.get(young), 'active');
  assert.equal(byId.get(feat), 'active');
  assert.equal(byId.get(held), 'active');
});
