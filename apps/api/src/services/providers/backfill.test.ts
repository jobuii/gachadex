import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { getDb, closeDb } = await import('../../db/client.ts');
const { initDb } = await import('../../db/init.ts');
const { upsertCardMarket } = await import('../markets.ts');
const { normNumber, normSet, matchCard, backfillProviderIds } = await import('./backfill.ts');
const { parseDisplayName } = await import('./display.ts');

await initDb();
const db = await getDb();
after(() => closeDb());

const tpl = (id: string, name: string, number: string, setName: string, tcgplayerId: number | null = null, priceUsd?: number) => ({
  id, tcgplayer_id: tcgplayerId, name, number, rarity: null, variant: 'Standard', image_url: null,
  updated_at: null, set: { slug: normSet(setName) ?? '', name: setName }, game: { slug: 'pokemon', name: 'Pokemon' },
  prices: priceUsd != null ? { raw: { near_mint: { tcgplayer: { market: priceUsd } } } } : null,
});

test('parseDisplayName splits the ingest displayName format', () => {
  assert.deepEqual(parseDisplayName('Charizard ex #223'), { name: 'Charizard ex', number: '223' });
  assert.deepEqual(parseDisplayName('Plain Name'), { name: 'Plain Name', number: null });
});

test('collector numbers + set names normalize across provider formats', () => {
  assert.equal(normNumber('006/197'), '6');
  assert.equal(normNumber('223'), '223');
  assert.equal(normNumber('TG12/TG30'), 'tg12');
  assert.equal(normSet('Base Set'), normSet('base-set'));
});

test('matchCard: unambiguous number+set match wins; ambiguity and misses return null', () => {
  const market = { number: '6', setName: 'Obsidian Flames' };
  const exact = tpl('uuid-1', 'Charizard ex', '006/197', 'Obsidian Flames');
  const otherSet = tpl('uuid-2', 'Charizard ex', '006/197', 'Base Set');
  const otherNum = tpl('uuid-3', 'Charizard ex', '007/197', 'Obsidian Flames');

  assert.equal(matchCard(market, [exact, otherSet, otherNum]), exact);
  assert.equal(matchCard(market, [exact, { ...exact, id: 'uuid-dupe' }]), null, 'two same-set variants = ambiguous');
  assert.equal(matchCard(market, [otherNum]), null, 'no number match');
  assert.equal(matchCard({ ...market, number: null }, [exact]), null, 'no collector number = never stamp');
  // no stored set name: a UNIQUE number match is still acceptable
  assert.equal(matchCard({ ...market, setName: null }, [exact, otherNum]), exact);
  assert.equal(matchCard({ ...market, setName: null }, [exact, otherSet]), null, 'number alone ambiguous');
});

test('printing-variant ambiguity is resolved by price proximity — and never guessed without it', () => {
  // Base Set Charizard #4: Unlimited ($400) vs 1st Edition ($4000) — same set, same number
  const unlimited = tpl('uuid-unl', 'Charizard', '4/102', 'Base Set', 1, 400);
  const firstEd = tpl('uuid-1st', 'Charizard', '4/102', 'Base Set', 2, 4000);
  const market = { number: '4', setName: 'Base Set', priceUsd: 420 };

  assert.equal(matchCard(market, [unlimited, firstEd]), unlimited, 'the market price pins the variant');
  assert.equal(matchCard({ ...market, priceUsd: 3800 }, [unlimited, firstEd]), firstEd);
  assert.equal(matchCard({ ...market, priceUsd: null }, [unlimited, firstEd]), null, 'no price = stays ambiguous');
  assert.equal(matchCard({ ...market, priceUsd: 1500 }, [unlimited, firstEd]), null, 'price near neither = ambiguous');
  // two candidates inside the band: never guess
  const shadowless = tpl('uuid-shdw', 'Charizard', '4/102', 'Base Set', 3, 450);
  assert.equal(matchCard(market, [unlimited, shadowless, firstEd]), null);
  // unpriced candidates can never price-match
  const unpriced = tpl('uuid-x', 'Charizard', '4/102', 'Base Set', 4);
  assert.equal(matchCard(market, [unpriced, firstEd]), null);
  // the tie-break NEVER fires across sets: same number in different sets stays strictly ambiguous
  const otherSetSameNum = tpl('uuid-os', 'Charizard', '4/130', 'Base Set 2', 5, 4000);
  assert.equal(matchCard({ number: '4', setName: null, priceUsd: 420 }, [unlimited, otherSetSameNum]), null);
});

test('backfill end-to-end: stamps unambiguous matches, reports the rest, idempotent + conflict-safe', async () => {
  const m1 = await upsertCardMarket(db, {
    symbol: 'bf-1', cardId: 'bf-1', displayName: 'Charizard #6', variant: 'holofoil',
    imageSmall: null, metadata: { setName: 'Obsidian Flames' },
  });
  const m2 = await upsertCardMarket(db, {
    symbol: 'bf-2', cardId: 'bf-2', displayName: 'Pikachu #25', variant: 'holofoil',
    imageSmall: null, metadata: { setName: 'Jungle' },
  });
  await upsertCardMarket(db, {
    symbol: 'bf-3', cardId: 'bf-3', displayName: 'Mew #11', variant: 'holofoil',
    imageSmall: null, metadata: { setName: 'Promo' },
  });

  const fixtures: Record<string, any[]> = {
    Charizard: [tpl('uuid-char', 'Charizard', '006/197', 'Obsidian Flames', 510327)],
    Pikachu: [], // no results
    Mew: [tpl('uuid-mew', 'Mew', '011/100', 'Promo'), tpl('uuid-mew2', 'Mew', '011/100', 'Promo')], // ambiguous
  };
  const stub = {
    searchCards: async ({ q }: { q?: string }) => ({ data: fixtures[q ?? ''] ?? [], total: 0, limit: 50, offset: 0 }),
  } as unknown as InstanceType<typeof import('./tcgpricelookup.ts').TcgPriceLookupClient>;

  // dry run: nothing written
  const dry = await backfillProviderIds(db, stub, { apply: false });
  assert.equal(dry.matched, 1);
  assert.equal(dry.applied, 0);
  const before = await db.query<{ p: string | null }>(`SELECT provider_card_id AS p FROM markets WHERE id = $1`, [m1]);
  assert.equal(before.rows[0].p, null);

  // apply: the unambiguous match is stamped with BOTH ids; the rest are reported
  const applied = await backfillProviderIds(db, stub, { apply: true });
  assert.equal(applied.matched, 1);
  assert.equal(applied.applied, 1);
  assert.deepEqual(
    applied.unmatched.map((u) => [u.name, u.reason]).sort(),
    [['Mew #11', 'ambiguous'], ['Pikachu #25', 'no-results']],
  );
  const row = await db.query<{ p: string | null; t: string | null }>(
    `SELECT provider_card_id AS p, tcgplayer_id::text AS t FROM markets WHERE id = $1`, [m1],
  );
  assert.deepEqual(row.rows[0], { p: 'uuid-char', t: '510327' });

  // idempotent: the stamped market is no longer a candidate
  const again = await backfillProviderIds(db, stub, { apply: true });
  assert.equal(again.total, applied.total - 1);

  // conflict: a market matching an ALREADY-CLAIMED provider card is reported, not stamped
  await db.query(`UPDATE markets SET display_name = 'Charizard #6', metadata = '{"setName":"Obsidian Flames"}' WHERE id = $1`, [m2]);
  const conflict = await backfillProviderIds(db, stub, { apply: true });
  assert.deepEqual(
    conflict.unmatched.map((u) => u.reason).sort(),
    ['ambiguous', 'conflict'],
  );
  const m2row = await db.query<{ p: string | null }>(`SELECT provider_card_id AS p FROM markets WHERE id = $1`, [m2]);
  assert.equal(m2row.rows[0].p, null);
});
