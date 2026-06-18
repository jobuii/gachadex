import { test } from 'node:test';
import assert from 'node:assert/strict';
import { equalWeightLevel, cappedWeightLevel, cappedWeights, BASE_VALUE_E6 } from './index-weighting.ts';

const e6 = (n: number) => BigInt(Math.round(n * 1_000_000));
const pmap = (o: Record<string, number>) => new Map(Object.entries(o).map(([k, v]) => [k, e6(v)] as const));
const mem = (o: Record<string, number>) => Object.entries(o).map(([cardId, v]) => ({ cardId, priceE6: e6(v) }));

// --- equal-weight (G&P) -----------------------------------------------------

test('equal-weight: launches at the 1000 base with no prior pass', () => {
  assert.equal(equalWeightLevel(0n, new Map(), mem({ A: 100 })), BASE_VALUE_E6);
});

test('equal-weight: a flat pass is exact (no drift)', () => {
  assert.equal(equalWeightLevel(e6(1000), pmap({ A: 100, B: 5 }), mem({ A: 100, B: 5 })), e6(1000));
});

test('equal-weight: +10%/-10% cancel regardless of price level (no single-card domination)', () => {
  // GJ would be dragged by the $100 card; equal-weight averages the % moves -> unchanged.
  assert.equal(equalWeightLevel(e6(1000), pmap({ A: 100, B: 1 }), mem({ A: 110, B: 0.9 })), e6(1000));
});

test('equal-weight: chains only over common names (composition change is continuous)', () => {
  // B leaves, C joins -> only A has a prior price, so the return is A's alone; no jump from C entering.
  assert.equal(equalWeightLevel(e6(1000), pmap({ A: 100, B: 100 }), mem({ A: 120, C: 50 })), e6(1200));
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

test('capped-weight: a flat pass is exact even when the cap cannot fully bind', () => {
  assert.equal(cappedWeightLevel(e6(1000), pmap({ A: 9000, b: 50, c: 50 }), mem({ A: 9000, b: 50, c: 50 }), 500), e6(1000));
});

test('chained series do not drift over many flat passes (the frozen-feed case)', () => {
  // The live feed can sit unchanged for days; re-pricing every pass must NOT wander the level off its base.
  const prev = pmap(giant());
  const same = mem(giant());
  let eq = e6(1000);
  let cap = e6(1000);
  for (let i = 0; i < 50; i++) {
    eq = equalWeightLevel(eq, prev, same);
    cap = cappedWeightLevel(cap, prev, same, 500);
  }
  assert.equal(eq, e6(1000));
  assert.equal(cap, e6(1000));
});

test('capped vs equal diverge from price-weight on a giant move (concentration killed)', () => {
  const base = giant();
  const moved = { ...base, A: 9900 }; // the giant +10%, the rest flat
  // Pokedaq (capped 5%): A contributes only 5% -> +0.5% -> 1005.000
  assert.equal(cappedWeightLevel(e6(1000), pmap(base), mem(moved), 500), e6(1005));
  // G&P (equal): (1.1 + 20·1.0) / 21 -> +0.4761% -> 1004.761
  assert.equal(equalWeightLevel(e6(1000), pmap(base), mem(moved)), 1004761000n);
  // (GJ price-weighted, by contrast, would be 10,900 / 10,000 = +9% -> 1090 — the divisor method in oracle.ts.)
});
