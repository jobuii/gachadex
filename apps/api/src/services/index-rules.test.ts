import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconstitute, onePerProduct, substitutes, tierRules, type Candidate } from './index-rules.ts';

// R2–R5, R11, R12 at their edges, on a 10-card basket (join ≤ 9, stay ≤ 11) — the same shape as Top 100 (90/110).
const T = { n: 10, joinRank: 9, stayRank: 11 };
// Card i is ranked i (price 1000 − i): the ranking is the card number.
const c = (i: number, o: Partial<Candidate> = {}): Candidate => ({
  marketId: `m${String(i).padStart(2, '0')}`, productKey: `p${i}`, priceE6: BigInt(1000 - i), member: false, canJoin: true, cause: null, excluded: false, ...o,
});
const ids = (xs: string[]) => xs.slice().sort();

test('tier rules: Top 100 90/110, Top 250 225/275, Graded scales with its size, Sealed is not governed', () => {
  assert.deepEqual(tierRules('top-100', 100), { n: 100, joinRank: 90, stayRank: 110 });
  assert.deepEqual(tierRules('top-250', 100), { n: 250, joinRank: 225, stayRank: 275 });
  assert.deepEqual(tierRules('graded', 100), { n: 100, joinRank: 90, stayRank: 110 });
  assert.equal(tierRules('sealed', 100), null);
  assert.deepEqual(tierRules('top-250', 100, 120), { n: 250, joinRank: 225, stayRank: 300 }, 'the wider buffer: 90 / 120');
});

test('R4 join edge: a non-member at rank 9 joins, at rank 10 it joins only to fill a slot', () => {
  // members ranked 1–7 + 11 (all stay); joiners at 9 and 10 → 9 joins by rank, 10 only because a slot is free
  const cands = [...[1, 2, 3, 4, 5, 6, 7, 11].map((i) => c(i, { member: true })), c(8, { canJoin: false }), c(9), c(10), c(12)];
  const r = reconstitute(cands, T);
  assert.ok(r.adds.includes('m09'), 'rank 9 = the join rank');
  assert.equal(r.members.length, 10);
  assert.ok(r.adds.includes('m10'), 'rank 10 fills the one free slot (better ranked than 12)');
  assert.deepEqual(r.removes, []);
});

test('R4 stay edge: a member at rank 11 stays, at rank 12 it leaves for rank', () => {
  const cands = [...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => c(i, { member: true })), c(11, { member: true }), c(12, { member: true }), c(9)];
  const r = reconstitute(cands, T);
  assert.ok(r.members.includes('m11'), 'rank 11 = the stay rank');
  assert.ok(!r.members.includes('m12'));
  assert.deepEqual(r.removes, [{ marketId: 'm12', reason: 'rank' }]);
  assert.deepEqual(r.adds, ['m09']);
});

test('R4 too many qualify: exactly N stay, the lowest-ranked members go', () => {
  const cands = [...[2, 3, 4, 5, 6, 7, 8, 10, 11].map((i) => c(i, { member: true })), c(1), c(9)]; // 9 members + 2 joiners = 11
  const r = reconstitute(cands, T);
  assert.equal(r.members.length, 10);
  assert.deepEqual(r.removes, [{ marketId: 'm11', reason: 'rank' }]);
  assert.deepEqual(ids(r.adds), ['m01', 'm09']);
});

test('R4 fewer than N eligible: the basket holds fewer, it is never padded with cards that may not join', () => {
  const r = reconstitute([c(1), c(2, { canJoin: false }), c(3)], T);
  assert.deepEqual(r.members, ['m01', 'm03']);
});

test('R5 causes remove a member whatever its rank; R11 hand removals stay out until cleared', () => {
  const cands = [c(1, { member: true, cause: 'stale' }), c(2, { member: true, excluded: true }), c(3, { member: true }), c(4, { excluded: true })];
  const r = reconstitute(cands, T);
  assert.deepEqual(r.removes, [{ marketId: 'm01', reason: 'stale' }, { marketId: 'm02', reason: 'hand' }]);
  assert.deepEqual(r.members, ['m03'], 'the excluded non-member m04 may not join either');
  assert.deepEqual(r.reserves, []);
});

test('R3 is for joining only: a member that would fail R3 (e.g. low confidence) stays', () => {
  const r = reconstitute([c(1, { member: true, canJoin: false }), c(2)], T);
  assert.deepEqual(r.members, ['m01', 'm02']);
});

test('R12 one printing per product: the most valuable printing is the member, the other leaves', () => {
  const foil = c(1, { productKey: 'flooded-strand' });
  const normal = c(5, { productKey: 'flooded-strand', member: true });
  assert.deepEqual(onePerProduct([normal, foil]).kept.map((x) => x.marketId), ['m01']);
  const r = reconstitute([foil, normal, c(2)], T);
  assert.deepEqual(r.members, ['m01', 'm02']);
  assert.deepEqual(r.removes, [{ marketId: 'm05', reason: 'printing' }]);
});

test('reserves: the next-best cards that may join, in rank order, capped', () => {
  const cands = Array.from({ length: 16 }, (_, k) => c(k + 1, { canJoin: k + 1 !== 13 }));
  const r = reconstitute(cands, T, 3);
  assert.equal(r.members.length, 10);
  assert.deepEqual(r.reserves, ['m11', 'm12', 'm14'], 'm13 may not join, so it is no reserve');
});

test('B substitutes: reserves first, then the best that may join now; never a barred card or a second printing of a held product', () => {
  const c = (id: string, usd: number, o: Partial<Candidate> = {}): Candidate =>
    ({ marketId: id, productKey: id, priceE6: BigInt(usd), member: false, canJoin: true, cause: null, excluded: false, ...o });
  const cands = [c('top', 90), c('held-sib', 80, { productKey: 'P' }), c('barred', 70), c('stale', 60, { canJoin: false }), c('res', 10), c('next', 50)];
  assert.deepEqual(substitutes(cands, ['res'], 3, new Set(['barred']), new Set(['P'])), ['res', 'top', 'next']);
  assert.deepEqual(substitutes(cands, [], 0, new Set(), new Set()), []);
});
