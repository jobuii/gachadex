import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chainStep, cappedWeights, BASE_VALUE_E6, type IndexWeighting } from './index-weighting.ts';

const e6 = (n: number) => BigInt(Math.round(n * 1_000_000));
const pmap = (o: Record<string, number>) => new Map(Object.entries(o).map(([k, v]) => [k, e6(v)] as const));
const OPTS = { outlierFactor: 2, capBps: 500 };
const step = (w: IndexWeighting, level: number, prev: Record<string, number>, cur: Record<string, number>) =>
  chainStep(e6(level), pmap(prev), pmap(cur), w, OPTS);
const ALL: IndexWeighting[] = ['price', 'equal', 'capped'];

test('launches at the 1000 base with no prior level or snapshot', () => {
  for (const w of ALL) {
    assert.equal(chainStep(0n, new Map(), pmap({ A: 100 }), w, OPTS).levelE6, BASE_VALUE_E6);
    assert.equal(chainStep(e6(1500), new Map(), pmap({ A: 100 }), w, OPTS).launched, true);
  }
});

test('a flat pass is exact for every method (no drift)', () => {
  for (const w of ALL) assert.equal(step(w, 1000, { A: 100, B: 5, C: 0.5 }, { A: 100, B: 5, C: 0.5 }).levelE6, e6(1000));
});

test('many flat passes never wander off the level (the frozen-feed case)', () => {
  for (const w of ALL) {
    let lvl = e6(1000);
    for (let i = 0; i < 200; i++) lvl = chainStep(lvl, pmap({ A: 9000, b: 50, c: 50 }), pmap({ A: 9000, b: 50, c: 50 }), w, OPTS).levelE6;
    assert.equal(lvl, e6(1000));
  }
});

test('G&P is geometric (Jevons): a bounce that returns to start ends EXACTLY flat — the Carli drift is gone', () => {
  // A 100→150→100, B 100→80→100 (all within the outlier guard). The old arithmetic chain gave
  // (1.5+0.8)/2 = 1.15 then (0.667+1.25)/2 = 0.958 → +10.2% on prices that went nowhere.
  let lvl = step('equal', 1000, { A: 100, B: 100 }, { A: 150, B: 80 }).levelE6;
  lvl = chainStep(lvl, pmap({ A: 150, B: 80 }), pmap({ A: 100, B: 100 }), 'equal', OPTS).levelE6;
  assert.equal(lvl, e6(1000));
});

test('G&P is the geometric mean of the price relatives', () => {
  // +21% and −1%… → sqrt(1.21 · 0.81) = 0.99 → 990
  assert.equal(step('equal', 1000, { A: 100, B: 100 }, { A: 121, B: 81 }).levelE6, e6(990));
});

test('GJ is the Σ-price ratio over the previous basket (the correct divisor adjustment)', () => {
  // 100+50 → 110+40: 150 → 150 = flat, even though one card is up 10% and the other down 20%
  assert.equal(step('price', 1000, { A: 100, B: 50 }, { A: 110, B: 40 }).levelE6, e6(1000));
  assert.equal(step('price', 1000, { A: 100, B: 100 }, { A: 120, B: 100 }).levelE6, e6(1100));
});

test('leavers count: a card that fell out of the basket still contributes its fall', () => {
  // B dropped (and so left the top-N) but still has a price this pass → its −40% is measured, not dropped.
  const r = step('price', 1000, { A: 100, B: 100 }, { A: 100, B: 60, C: 500 });
  assert.equal(r.levelE6, e6(800)); // (100+60)/(100+100)
  assert.equal(r.used, 2);
  // C is a new entrant: no prior price, contributes nothing this pass (it counts from the next).
});

test('a card with no price this pass is imputed (left out), never forced to a zero return', () => {
  const r = step('equal', 1000, { A: 100, B: 100 }, { A: 110 });
  assert.equal(r.levelE6, e6(1100)); // the pass move comes from A alone
  assert.equal(r.missing, 1);
});

test('outlier guard: a ≥2× single-pass move is excluded (the $0.99 → $1,067 mis-print)', () => {
  for (const w of ALL) {
    const r = step(w, 1000, { A: 100, B: 100, ENTEI: 0.99 }, { A: 100, B: 100, ENTEI: 1067 });
    assert.equal(r.levelE6, e6(1000), `${w}: the bad print moves nothing`);
    assert.deepEqual(r.outliers, ['ENTEI']);
  }
  // …and a crash to below half is excluded too
  assert.deepEqual(step('equal', 1000, { A: 100, B: 100 }, { A: 100, B: 40 }).outliers, ['B']);
  // a big but plausible move (+80%) is kept
  assert.equal(step('equal', 1000, { A: 100 }, { A: 180 }).levelE6, e6(1800));
});

test('a flip-flopping print (19 → 3960 → 19) leaves the index untouched in BOTH passes', () => {
  for (const w of ALL) {
    let lvl = step(w, 1000, { A: 100, BIRDS: 19 }, { A: 100, BIRDS: 3960 }).levelE6;
    lvl = chainStep(lvl, pmap({ A: 100, BIRDS: 3960 }), pmap({ A: 100, BIRDS: 19 }), w, OPTS).levelE6;
    assert.equal(lvl, e6(1000), w);
  }
});

test('nothing measurable this pass → the level carries forward', () => {
  const r = step('equal', 1234, { A: 100 }, {});
  assert.equal(r.levelE6, e6(1234));
  assert.equal(r.launched, false);
});

// --- capped weights (Pokedaq) -----------------------------------------------

const giant = (): Record<string, number> => {
  const o: Record<string, number> = { A: 9000 }; // one $9k card + 20 × $50 = $10,000 basket
  for (let i = 0; i < 20; i++) o['s' + i] = 50;
  return o;
};

test('capped-weights: a dominant card is pinned at 5%, the excess redistributed', () => {
  const items = Object.entries(giant()).map(([cardId, v]) => ({ cardId, prevE6: e6(v) }));
  const w = cappedWeights(items, 500);
  const capE6 = 50_000n; // 5% of SCALE (1e6)
  for (const [, wi] of w) assert.ok(wi <= capE6, 'no weight exceeds the 5% cap');
  assert.equal(w.get('A'), capE6); // the giant sits exactly at the cap (was ~90% uncapped)
});

test('a basket too small for the cap (N × 5% ≤ 100%) is equal-weighted — never the cheapest names holding the excess', () => {
  // MTG Pokedaq on 2026-06-25 (found 2026-10-17): 9 flat cards + one cheap card at 1.904× (under the 2× outlier guard).
  const prev = { a: 3600, b: 3200, c: 2501, d: 2108, e: 1796, f: 1765, g: 1675, h: 1447, ring: 685, i: 186 };
  const w = cappedWeights(Object.entries(prev).map(([cardId, p]) => ({ cardId, prevE6: e6(p) })), 500);
  assert.equal(w.size, 10);
  assert.deepEqual(new Set(w.values()), new Set([50_000n]), 'every name at the 5% cap');
  const level = step('capped', 1000, prev, { ...prev, ring: 1304.2 }).levelE6;
  assert.equal(level, BigInt(Math.round(1e9 * Math.pow(1304.2 / 685, 1 / 10))), 'equal weight at both ends → the geometric mean, +6.6% — not +42.7%');
  // 20 names is exactly feasible (20 × 5% = 100%) → also all at the cap; 21 → price weights, capped.
  const n = (k: number) => Array.from({ length: k }, (_, j) => ({ cardId: `n${j}`, prevE6: e6(j + 1) }));
  assert.deepEqual(new Set(cappedWeights(n(20), 500).values()), new Set([50_000n]));
  const w21 = cappedWeights(n(21), 500);
  assert.equal(w21.size, 21);
  assert.ok(w21.get('n0')! < w21.get('n10')!, '21 names: price-weighted again');
});

test('no name is left over the cap, even when the cheap names are < 1 ppm of the basket (review 2026-10-17)', () => {
  const items = [{ cardId: 'giant', prevE6: e6(1_000_000) }, { cardId: 'tiny', prevE6: e6(2) },
    ...Array.from({ length: 19 }, (_, j) => ({ cardId: `c${j}`, prevE6: e6(0.5) }))];
  const w = cappedWeights(items, 500);
  for (const [id, wi] of w) assert.ok(wi <= 50_000n, `${id} at ${wi} is over the 5% cap`);
  assert.equal(w.get('giant'), 50_000n);
});

test('Pokedaq (Törnqvist) is time-reversible: a member that bounces and returns leaves the level unchanged (review 2026-10-17)', () => {
  // A capped giant + 20 uncapped names (the case where P₀-only weights drift: arithmetic up when capped, geometric down
  // when not), and a 40-name basket with no cap binding.
  const giantBasket = giant();
  const wide = Object.fromEntries(Array.from({ length: 40 }, (_, j) => [`w${j}`, 10 + 7 * j]));
  for (const [base, moves] of [
    [giantBasket, { s0: 75, A: 12000 }],
    [giantBasket, { s0: 30 }],
    [wide, { w0: 15 }],
    [wide, { w5: 30, w30: 300 }],
  ] as [Record<string, number>, Record<string, number>][]) {
    const there = { ...base, ...moves };
    const up = step('capped', 1000, base, there);
    const back = chainStep(up.levelE6, pmap(there), pmap(base), 'capped', OPTS);
    assert.ok(up.levelE6 !== e6(1000), 'the move registers');
    assert.ok(Math.abs(Number(back.levelE6) - 1e9) <= 2, `round trip ${JSON.stringify(moves)} ends at ${Number(back.levelE6) / 1e6}`);
  }
});

test('the three methods diverge as designed on a giant +10% move', () => {
  const base = giant();
  const moved = { ...base, A: 9900 };
  // A capped at 5% at both ends → 1.1^0.05 = +0.48% (± the e6 water-fill residue)
  assert.ok(Math.abs(Number(step('capped', 1000, base, moved).levelE6) - 1e9 * Math.pow(1.1, 0.05)) < 100);
  assert.equal(step('price', 1000, base, moved).levelE6, e6(1090)); // 10,900 / 10,000
  // equal: (1.1 · 1^20)^(1/21) → +0.4549%
  assert.equal(step('equal', 1000, base, moved).levelE6, BigInt(Math.round(1e9 * Math.pow(1.1, 1 / 21))));
});
