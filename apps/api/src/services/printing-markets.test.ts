import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// One market per printing (2026-10-18 plan P5, Q-B3/Q-B4): the printing key + its boot backfill, the switch that relaxes
// the one-market-per-product index (and a rollback still boots), the live card-label guard, discovery listing the
// other printings of featured cards, and one bad card never stopping the price pass.
process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { applyMarketGuards, PRINTING_BACKFILL_SQL } = await import('../db/market-guards.ts');
const { config } = await import('../config.ts');
const { upsertCardMarket, cardSymbol, listMarketsWithData } = await import('./markets.ts');
const { discoverGame, printingSiblings, retireDeadMarkets, mayJoinProduct } = await import('./providers/discovery.ts');
const { normVariant } = await import('./providers/backfill.ts');
const { ingest } = await import('./oracle.ts');

await initDb();
const db = await getDb();
after(() => closeDb());
const cfg = config as { printingMarketsEnabled: boolean };
const isUnique = async () =>
  (await db.query<{ u: boolean }>(`SELECT i.indisunique AS u FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'idx_markets_tcgplayer'`)).rows[0]?.u;
const OLD_BOOT_LINE = `CREATE UNIQUE INDEX IF NOT EXISTS idx_markets_tcgplayer ON markets(tcgplayer_id) WHERE tcgplayer_id IS NOT NULL`;

async function market(sym: string, over: Partial<Parameters<typeof upsertCardMarket>[1]> = {}) {
  return upsertCardMarket(db, { game: 'mtg', symbol: sym, cardId: sym, displayName: sym, variant: 'Normal', imageSmall: null, ...over });
}

test('printing key: the boot backfill (SQL) gives the same key as normVariant for every live spelling', async () => {
  // every distinct markets.variant on the live database, 18 Oct 2026 (read-only query)
  const live = ['Normal', 'Foil', 'normal', 'foil', 'serializedFoil', 'mangaAltArt', 'specialAltArt', 'altArt', 'holofoil', 'Holofoil',
    'firstEditionHolofoil', 'Reverse Holofoil', 'Unlimited Holofoil', '1st Edition Holofoil', 'masterBallReverseHolofoil',
    'reverseHolofoil', 'Unlimited', 'pokemonCenterStamp', 'firstEdition', 'jumbo', ''];
  const backfill = PRINTING_BACKFILL_SQL;
  for (const [i, v] of live.entries()) {
    await db.query(`INSERT INTO markets(id, kind, game, symbol, display_name, card_id, variant) VALUES($1, 'card', 'pokemon', $1, $1, $1, $2)`, [`bf-${i}`, v]);
  }
  await db.query(backfill);
  const got = await db.query<{ variant: string; printing: string | null }>(`SELECT variant, printing FROM markets WHERE id LIKE 'bf-%' ORDER BY id`);
  for (const r of got.rows) assert.equal(r.printing, normVariant(r.variant), r.variant);
  assert.equal(got.rows.find((r) => r.variant === '1st Edition Holofoil')?.printing, 'firsteditionholofoil');
  await db.query(`DELETE FROM markets WHERE id LIKE 'bf-%'`);
});

test('switch on → two printings of one product; same printing twice refused; an old build still boots; off again restores the guard', async () => {
  assert.equal(await isUnique(), true, 'off (default): one market per product');
  await market('mtg:fs-foil', { tcgplayerId: 10493, variant: 'Foil' });
  await assert.rejects(market('mtg:fs-normal', { tcgplayerId: 10493, variant: 'Normal' }), /idx_markets_tcgplayer/);

  cfg.printingMarketsEnabled = true;
  try {
    await applyMarketGuards(db);
    assert.equal(await isUnique(), false);
    await db.query(OLD_BOOT_LINE); // rollback: the pre-P5 schema line finds the name taken and does nothing
    assert.equal(await isUnique(), false);
    await market('mtg:fs-normal', { tcgplayerId: 10493, variant: 'Normal' });
    await assert.rejects(market('mtg:fs-foil-2', { tcgplayerId: 10493, variant: 'foil' }), /idx_markets_tcgplayer_printing/, 'Foil and foil are one printing');
  } finally {
    cfg.printingMarketsEnabled = false;
  }
  const logs: string[] = [];
  await applyMarketGuards(db, (m) => logs.push(m));
  assert.equal(await isUnique(), false, 'two printings exist → the guard stays relaxed');
  assert.match(logs.join(), /printing markets exist/);
  await db.query(`DELETE FROM markets WHERE symbol = 'mtg:fs-normal'`);
  await applyMarketGuards(db);
  assert.equal(await isUnique(), true, 'no twins left → one market per product again');
});

test('live card labels are unique per game; a retired market may share one but is never revived onto it', async () => {
  await market('pokemon:holo', { game: 'pokemon', cardId: 'base1-4', tcgplayerId: 42382, variant: 'Holofoil' });
  const jumbo = await market('pokemon:jumbo', { game: 'pokemon', cardId: 'base1-4x', tcgplayerId: 179079, variant: 'jumbo' });
  await assert.rejects(db.query(`UPDATE markets SET card_id = 'base1-4' WHERE id = $1`, [jumbo]), /idx_markets_live_card_id/);
  await db.query(`UPDATE markets SET status = 'delisted', card_id = 'base1-4', featured = true WHERE id = $1`, [jumbo]);
  // discovery's revive of featured retired markets skips it instead of failing the whole statement
  cfg.printingMarketsEnabled = false;
  const client = { searchCards: async () => ({ data: [], total: 0, limit: 100, offset: 0 }), getCardsByIds: async () => [] } as never;
  await discoverGame(db, client, 'pokemon', { apply: true, fresh: true, force: true }); // force: the test DB's feed is pokemontcg
  assert.equal((await db.query<{ status: string }>(`SELECT status FROM markets WHERE id = $1`, [jumbo])).rows[0].status, 'delisted');
  await market('mtg:other', { game: 'mtg', cardId: 'base1-4', tcgplayerId: 1 }); // another game: fine
});

type TplCardT = import('./providers/tcgpricelookup.ts').TplCard;
const tpl = (id: string, usd: number, tid: number, variant: string, liquid = true): TplCardT => ({
  id, tcgplayer_id: tid, name: 'Birds of Paradise', number: '165', rarity: 'Rare', variant, image_url: null,
  updated_at: '2026-10-18T00:00:00Z', set: { slug: 'm12', name: 'M12' }, game: { slug: 'mtg', name: 'Magic' },
  prices: { raw: { near_mint: { tcgplayer: { market: usd }, ...(liquid ? { ebay: { avg_7d: usd } } : {}) } } },
});
const catalog = (cards: TplCardT[]) =>
  ({
    searchCards: async ({ offset = 0, limit = 100 }: { offset?: number; limit?: number }) => ({ data: cards.slice(offset, offset + limit), total: cards.length, limit, offset }),
    getCardsByIds: async (ids: string[]) => cards.filter((c) => ids.includes(c.id)),
  }) as never;

test('printingSiblings: other listable printings of the featured products only', () => {
  const kept = [
    { id: 'bird-foil', price: 40, tid: 7, liq: true },
    { id: 'bird-normal', price: 12, tid: 7, liq: true },
    { id: 'bird-etched', price: 15, tid: 7, liq: false }, // no sales signal
    { id: 'other-normal', price: 30, tid: 9, liq: true }, // product not featured
    { id: 'bird-normal', price: 12, tid: 7, liq: true }, // a resumed crawl holds it twice
  ];
  assert.deepEqual(printingSiblings(kept, [kept[0]]).map((c) => c.id), ['bird-normal']);
});

test('discovery: switch on lists the other printing (not featured, own symbol + label, Scrydex ids copied); off lists none', async () => {
  const cards = [tpl('bird-foil', 40, 7700, 'Foil'), tpl('bird-normal', 12, 7700, 'Normal')];
  await discoverGame(db, catalog(cards), 'mtg', { apply: true, fresh: true, topN: 5 });
  const one = await db.query(`SELECT 1 FROM markets WHERE tcgplayer_id = 7700`);
  assert.equal(one.rows.length, 1, 'switch off: the top printing only');
  await db.query(`UPDATE markets SET scrydex_card_id = 'sx-birds', scrydex_expansion_id = 'm12' WHERE tcgplayer_id = 7700`);

  cfg.printingMarketsEnabled = true;
  try {
    await applyMarketGuards(db);
    await discoverGame(db, catalog(cards), 'mtg', { apply: true, fresh: true, topN: 5 });
  } finally {
    cfg.printingMarketsEnabled = false;
  }
  const rows = (await db.query<{ symbol: string; card_id: string; featured: boolean; printing: string; scrydex_card_id: string; scrydex_expansion_id: string }>(
    `SELECT symbol, card_id, featured, printing, scrydex_card_id, scrydex_expansion_id FROM markets WHERE tcgplayer_id = 7700 ORDER BY featured DESC`,
  )).rows;
  assert.deepEqual(rows.map((r) => [r.symbol, r.card_id, r.featured, r.printing]), [
    [cardSymbol('mtg', 'bird-foil'), 'bird-foil', true, 'foil'],
    [cardSymbol('mtg', 'bird-normal'), 'bird-normal', false, 'normal'],
  ]);
  assert.deepEqual([rows[1].scrydex_card_id, rows[1].scrydex_expansion_id], ['sx-birds', 'm12'], 'priced by Scrydex like its sibling');
  const view = (await listMarketsWithData(db)).filter((m) => m.tcgplayerId === '7700');
  assert.deepEqual(view.map((m) => m.variant).sort(), ['Foil', 'Normal'], '/markets carries the printing for the chips');

  // the weekly retirement keeps a featured card's other printing listed
  await db.query(`UPDATE markets SET created_at = now() - interval '90 days' WHERE tcgplayer_id = 7700`);
  const retired = await retireDeadMarkets(db, 30);
  const sib = (await db.query<{ id: string }>(`SELECT id FROM markets WHERE symbol = $1`, [cardSymbol('mtg', 'bird-normal')])).rows[0].id;
  assert.ok(!retired.includes(sib));
});

test('discovery waits on a product whose market is Scrydex-only (its printing name may differ)', async () => {
  await market('mtg:sx-only', { cardId: 'sx-only', tcgplayerId: 8800, variant: 'normal' }); // provider_card_id NULL
  const cards = [tpl('nv-normal', 50, 8800, 'Normal'), tpl('nv-foil', 20, 8800, 'Foil')];
  cfg.printingMarketsEnabled = true;
  try {
    await discoverGame(db, catalog(cards), 'mtg', { apply: true, fresh: true, topN: 5 });
  } finally {
    cfg.printingMarketsEnabled = false;
  }
  assert.equal((await db.query(`SELECT 1 FROM markets WHERE symbol = $1`, [cardSymbol('mtg', 'nv-foil')])).rows.length, 0);
});

test('price pass: one card that can\'t land is skipped — the rest are priced and the indices still build', async () => {
  await market('mtg:taken', { cardId: 'taken', providerCardId: 'p-taken', tcgplayerId: 9901 });
  const E6 = 1_000_000n;
  const oc = (symbol: string, cardId: string, providerCardId: string, tcgplayerId: number) => ({
    game: 'mtg', symbol, cardId, displayName: symbol, variant: 'Normal', imageSmall: null, providerCardId, tcgplayerId,
    rawE6: 50n * E6, observedAt: new Date(), featured: true, productType: 'single' as const,
  });
  const r = await ingest(db, async () => [
    oc('mtg:clash', 'clash', 'p-taken', 9902), // provider id another market holds → its upsert throws
    oc('mtg:fine', 'fine', 'p-fine', 9903),
  ], null);
  assert.equal(r.cards, 1);
  assert.ok(r.indices >= 1, 'the MTG indices were built');
  assert.equal((await db.query(`SELECT 1 FROM oracle_prices o JOIN markets m ON m.id = o.market_id WHERE m.symbol = 'mtg:fine'`)).rows.length, 1);
});

test('mayJoinProduct: an empty product always; another printing only with the switch on and tcgpl-only markets there', () => {
  assert.equal(mayJoinProduct([], false), true);
  assert.equal(mayJoinProduct(['p-a'], false), false, 'switched off: one market per product, whatever the index allows');
  assert.equal(mayJoinProduct(['p-a'], true), true);
  assert.equal(mayJoinProduct(['p-a', null], true), false, 'a Scrydex-only market may be the same card under another name');
});

test('discovery never makes a featured twin of a Scrydex-only market (staffStamp vs Holofoil), switch on or off', async () => {
  await market('mtg:stamp-sx', { cardId: 'stamp-sx', tcgplayerId: 9100, variant: 'staffStamp', featured: true }); // provider_card_id NULL
  for (const on of [true, false]) {
    cfg.printingMarketsEnabled = on;
    try {
      await applyMarketGuards(db);
      await discoverGame(db, catalog([tpl('stamp-tp', 400, 9100, 'Holofoil')]), 'mtg', { apply: true, fresh: true, topN: 5 });
    } finally {
      cfg.printingMarketsEnabled = false;
    }
    assert.equal((await db.query(`SELECT 1 FROM markets WHERE tcgplayer_id = 9100`)).rows.length, 1, `switch ${on ? 'on' : 'off'}`);
  }
});

test('discovery revives at most one market per card label — never fails the run on two retired twins', async () => {
  const a = await market('mtg:twin-a', { cardId: 'twin', tcgplayerId: 9200 });
  await db.query(`UPDATE markets SET status = 'delisted', featured = true WHERE id = $1`, [a]);
  const b = await market('mtg:twin-b', { cardId: 'twin-b', tcgplayerId: 9201 });
  await db.query(`UPDATE markets SET status = 'delisted', featured = true, card_id = 'twin' WHERE id = $1`, [b]);
  await discoverGame(db, catalog([]), 'mtg', { apply: true, fresh: true });
  const live = await db.query(`SELECT id FROM markets WHERE card_id = 'twin' AND status <> 'delisted'`);
  assert.equal(live.rows.length, 1);
});

test('retirement spares only the printings discovery listed on its latest run', async () => {
  const cards = [tpl('ret-foil', 60, 9300, 'Foil'), tpl('ret-normal', 15, 9300, 'Normal')];
  cfg.printingMarketsEnabled = true;
  try {
    await applyMarketGuards(db);
    await discoverGame(db, catalog(cards), 'mtg', { apply: true, fresh: true, topN: 5 });
    await db.query(`UPDATE markets SET created_at = now() - interval '90 days' WHERE tcgplayer_id = 9300`);
    const sib = (await db.query<{ id: string }>(`SELECT id FROM markets WHERE symbol = $1`, [cardSymbol('mtg', 'ret-normal')])).rows[0].id;
    assert.ok(!(await retireDeadMarkets(db, 30)).includes(sib), 'listed this run → kept');
    // next run: the Normal lost its sales signal → off the list → the sweep may retire it
    await discoverGame(db, catalog([cards[0], tpl('ret-normal', 15, 9300, 'Normal', false)]), 'mtg', { apply: true, fresh: true, topN: 5 });
    assert.ok((await retireDeadMarkets(db, 30)).includes(sib), 'no longer qualifies → retires like any long-tail market');
  } finally {
    cfg.printingMarketsEnabled = false;
  }
});

test('the printing key follows the feed\'s name for it; a pass that can\'t tell keeps it', async () => {
  const id = await market('mtg:follow', { cardId: 'follow', tcgplayerId: 9400, variant: 'normal' });
  await market('mtg:follow', { cardId: 'follow', tcgplayerId: 9400, variant: 'Foil' });
  await market('mtg:follow', { cardId: 'follow', tcgplayerId: 9400, variant: null });
  const r = (await db.query<{ variant: string; printing: string }>(`SELECT variant, printing FROM markets WHERE id = $1`, [id])).rows[0];
  assert.deepEqual([r.variant, r.printing], ['Foil', 'foil']);
});

test('the printing backfill skips a row whose key another market of the product holds (never fails the boot)', async () => {
  await db.query(`INSERT INTO markets(id, kind, game, symbol, display_name, card_id, variant, tcgplayer_id, printing)
                  VALUES('bf-a', 'card', 'mtg', 'bf-a', 'a', 'bf-a', 'Foil', 9500, 'foil'), ('bf-b', 'card', 'mtg', 'bf-b', 'b', 'bf-b', 'Normal', 9501, NULL)`);
  cfg.printingMarketsEnabled = true;
  try {
    await applyMarketGuards(db);
    await db.query(`INSERT INTO markets(id, kind, game, symbol, display_name, card_id, variant, tcgplayer_id) VALUES('bf-c', 'card', 'mtg', 'bf-c', 'c', 'bf-c', 'foil', 9500)`);
    await db.query(PRINTING_BACKFILL_SQL);
    const rows = (await db.query<{ id: string; printing: string | null }>(`SELECT id, printing FROM markets WHERE id LIKE 'bf-%' ORDER BY id`)).rows;
    assert.deepEqual(rows.map((r) => [r.id, r.printing]), [['bf-a', 'foil'], ['bf-b', 'normal'], ['bf-c', null]]);
  } finally {
    cfg.printingMarketsEnabled = false;
    await db.query(`DELETE FROM markets WHERE id LIKE 'bf-%'`);
    await applyMarketGuards(db);
  }
});
