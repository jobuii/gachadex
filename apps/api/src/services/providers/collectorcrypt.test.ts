import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toLobbyMachine, toLobbyCard, toLobbyWinner, getMachinesCached, __resetMachinesCache, type CcMachine, type CcPackNft, type CcWinner } from './collectorcrypt.ts';

// The mappers are where the money bugs live: CC's gacha reads are in DOLLARS and must become micro-USDC
// strings on the wire. These cover the dollar→e6 conversion, the tier-legend shaping, and missing fields.

test('toLobbyMachine: dollars→micro-USDC, tier legend from odds+ranges, game from code', () => {
  const m: CcMachine = {
    code: 'pokemon_50',
    name: 'Elite Pokémon Gacha Pack',
    price: 50,
    instantBuyback: 85,
    odds: { common: 0.8, uncommon: 0.15, rare: 0.04, epic: 0.01 },
    tierRanges: { common: { start: 30, end: 60 }, uncommon: { start: 60, end: 110 }, rare: { start: 110, end: 250 }, epic: { start: 250, end: 100000 } },
    stock: { common: 100, epic: 2 },
    thumbnailUrl: 'https://cc/img.png',
  };
  const out = toLobbyMachine(m);
  assert.equal(out.priceE6, '50000000'); // $50 → 50e6
  assert.equal(out.game, 'pokemon');
  assert.equal(out.buybackPct, 85);
  assert.equal(out.image, 'https://cc/img.png');
  assert.deepEqual(out.stock, { common: 100, epic: 2 });
  const common = out.tiers.find((t) => t.label === 'common')!;
  assert.equal(common.pct, 80); // 0.8 → 80%
  assert.equal(common.minE6, '30000000');
  assert.equal(common.maxE6, '60000000');
  const epic = out.tiers.find((t) => t.label === 'epic')!;
  assert.equal(epic.pct, 1); // 0.01 → 1%
});

test('toLobbyMachine: missing tierRanges/thumbnail/buyback degrade to null/0', () => {
  const m = { code: 'sealed_80', name: 'Sealed', price: 80, odds: { common: 1 }, stock: {} } as unknown as CcMachine;
  const out = toLobbyMachine(m);
  assert.equal(out.priceE6, '80000000');
  assert.equal(out.buybackPct, 0);
  assert.equal(out.image, null);
  assert.equal(out.tiers[0].minE6, null);
  assert.equal(out.tiers[0].maxE6, null);
});

test('toLobbyCard: nft_address→mint, insured_value→micro-USDC', () => {
  const n: CcPackNft = { nft_address: 'MintAbc', name: '2017 Charizard PSA 10', rarity: 'epic', image: 'https://cc/c.png', insured_value: 4475 };
  assert.deepEqual(toLobbyCard(n), { mint: 'MintAbc', name: '2017 Charizard PSA 10', imageUrl: 'https://cc/c.png', valueE6: '4475000000', rarity: 'epic', grade: 'PSA 10' });
});

test('toLobbyCard: grade comes from the full description when name is truncated past the grade', () => {
  // CC truncates `name` to 32 chars, dropping the grade; the full `description` still carries it.
  const n: CcPackNft = {
    nft_address: 'MintTrunc', name: '2021 #215 Umbreon VMAX ALT ART S',
    description: '2021 #215 Umbreon VMAX ALT ART SAR PSA 10 Evolving Skies', rarity: 'epic', image: 'https://cc/u.png', insured_value: 520,
  };
  assert.equal(toLobbyCard(n).grade, 'PSA 10');
});

test('toLobbyWinner: nested name/image, insuredValue→micro-USDC, prize_tier→tier', () => {
  const w: CcWinner = {
    winner: '7nB56jAX',
    nft_address: 'MintWin',
    nft: { content: { metadata: { name: 'Jerry Rice PSA 10' }, links: { image: 'https://cc/w.png' } } },
    insuredValue: 777,
    prize_tier: 1,
    pack_type: 'pokemon_50',
    created_at: 1700000000,
  };
  assert.deepEqual(toLobbyWinner(w), { winner: '7nB56jAX', mint: 'MintWin', name: 'Jerry Rice PSA 10', imageUrl: 'https://cc/w.png', valueE6: '777000000', tier: 1, packType: 'pokemon_50' });
});

test('toLobbyWinner: missing nested nft metadata → null name/image, still maps value', () => {
  const w = { winner: 'abc', nft_address: 'M', insuredValue: 12.5, prize_tier: 4, pack_type: 'sealed_80', created_at: 0 } as CcWinner;
  const out = toLobbyWinner(w);
  assert.equal(out.name, null);
  assert.equal(out.imageUrl, null);
  assert.equal(out.valueE6, '12500000'); // $12.50 → 12.5e6
});

test('getMachinesCached: ≤ 1 CC call per interval (cache hit, force, pause, stale-on-error)', async () => {
  __resetMachinesCache();
  let calls = 0;
  const okFetch = (async () => { calls++; return { ok: true, status: 200, json: async () => ({ machines: [{ code: 'pokemon_50', name: 'Elite', price: 50 }] }) }; }) as unknown as typeof fetch;

  // cold → one CC fetch
  let r = await getMachinesCached({ ttlMs: 10_000, paused: false, fetchFn: okFetch });
  assert.equal(calls, 1);
  assert.equal(r.machines.length, 1);
  // within the interval → served from cache, no new CC call
  await getMachinesCached({ ttlMs: 10_000, paused: false, fetchFn: okFetch });
  assert.equal(calls, 1);
  // force ("Refresh now") → re-queries CC
  await getMachinesCached({ ttlMs: 10_000, paused: false, force: true, fetchFn: okFetch });
  assert.equal(calls, 2);
  // paused → never re-queries, even when stale
  await getMachinesCached({ ttlMs: 0, paused: true, fetchFn: okFetch });
  assert.equal(calls, 2);
  // stale + not paused → re-queries
  await getMachinesCached({ ttlMs: 0, paused: false, fetchFn: okFetch });
  assert.equal(calls, 3);
  // CC error with a warm cache → serve the last-known list, don't throw
  const errFetch = (async () => ({ ok: false, status: 404, text: async () => 'down' })) as unknown as typeof fetch;
  r = await getMachinesCached({ ttlMs: 0, paused: false, fetchFn: errFetch });
  assert.equal(r.machines.length, 1);

  // concurrent cold requests → single-flight dedupes them into ONE CC call (no thundering herd)
  __resetMachinesCache();
  calls = 0;
  await Promise.all([0, 1, 2].map(() => getMachinesCached({ ttlMs: 10_000, paused: false, fetchFn: okFetch })));
  assert.equal(calls, 1);
});
