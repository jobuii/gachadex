import { randomUUID } from 'node:crypto';
import type { Db, Queryer } from '../db/client.ts';
import { config } from '../config.ts';
import { HttpError } from '../errors.ts';
import { usdc } from '../money.ts';
import { getOrCreateUserAccount, getOrCreateSystemAccount, postTxn } from './ledger.ts';
import { getNftCustodyKeypair } from './custody/wallet.ts';
import { createNftWithdrawNonce, verifyNftWithdrawStepUp } from './auth.ts';
import { spendGold, earnGold, reverseEarnedGold, goldEarnedForOpen, goldPriceForPack, FREE_PACK_GOLD } from './gold.ts';
import { openPosition } from './engine.ts';
import { lastMarkE6 } from './marks.ts';
import { gachaConfig, gachaMarkupE6 } from './gacha-config.ts';
import type { GachaChain } from './custody/gacha-chain.ts';
import { defaultCcClient, ccVerifyUrl, type CcClient, type CcOpenResult } from './providers/collectorcrypt.ts';
import { getAssetTransferInfo } from './das.ts';
import { settleSoldPrize, accrueGachaAffiliateShare, type SellBackResult } from './gacha-settle.ts';
export type { SellBackResult } from './gacha-settle.ts';

/**
 * Classic Gacha service (docs/classic-gacha-cc-packs-spec.md, P1–P4 — buy → open → sell-back / withdraw,
 * pay with USDC or loyalty Gold).
 *
 * Custodial + real-money: the user pays from their GDEX balance (the USDC ledger is the spend gate), the hot
 * wallet JIT-funds a per-user NFT-custody wallet, that wallet pays CC + receives the real graded-card NFT,
 * and a sell-back returns CC's buyback USDC to the hot wallet (altRecipient) with GDEX taking a 5% cut
 * (10% on an instant sell-on-reveal). A held NFT can instead be withdrawn to the user's own wallet (P2).
 *
 * The on-chain ops are behind an injected `GachaChain` and the CC API behind an injected `CcClient`, so the
 * money / idempotency / state-machine logic below is unit-tested with fakes; the live Solana + CC behavior is
 * the operator's real-funds test (spec P1). Money invariants (spec §16): receipt-before-payment; a row with a
 * payment_sig is never auto-failed; every failed/refunded buy posts exactly one GACHA_REFUND; the inventory
 * write is idempotent on the mint; sell-back locks the prize row + checks status='held'.
 */

const GACHA_OFF = () => new HttpError(404, 'classic gacha is not available');
const MAX_REVEAL_ATTEMPTS = 3;
const REVEAL_RETRY_MS = 1000; // gap between inline reveal-poll attempts (was 1500) — snappier reveal once CC's webhook lands
const TURBO_CONFIRM_ATTEMPTS = 3; // #6: in-request polls of CC pack-status to confirm a turbo auto-sell LANDED before crediting (else defer to the reconciler)
const RECONCILE_GRACE_MS = 90_000;
const RECONCILE_UNLANDED_MS = 600_000; // 10 min — a payment broadcast still unconfirmed by now provably expired (≫ the ~90s blockhash window); only then refund a stuck buy
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface GachaDeps {
  chain: GachaChain;
  cc?: CcClient;
  sleepMs?: (ms: number) => Promise<void>;
  now?: () => number; // injectable clock for the reconcile grace window (tests)
  getAssetInfo?: typeof getAssetTransferInfo; // injectable DAS owner lookup (tests); used to gate sell-back/withdraw reverts
}

export interface GachaCard { mint: string; name: string | null; grade: string | null; imageUrl: string | null; valueE6: string; rarity: string | null; marketId: string | null; year: string | null }
export interface OpenResult { openId: string; status: string; card: GachaCard | null; verifyUrl: string | null; turboRefundE6?: string | null; duplicate?: boolean }

interface OpenRow {
  id: string; user_id: string; machine_code: string; price_e6: string; markup_e6: string; paid_with: string; cc_memo: string | null;
  payment_sig: string | null; payment_attempted_at: string | null; custody_pubkey: string | null; status: string;
  nft_mint: string | null; nft_name: string | null; nft_image: string | null; grade: string | null;
  insured_value_e6: string | null; rarity: string | null; nft_market_id: string | null; nft_year: string | null; turbo_refund_e6: string | null; created_at: string;
}

const OPEN_COLS =
  `id, user_id, machine_code, price_e6::text AS price_e6, markup_e6::text AS markup_e6, paid_with, cc_memo, payment_sig, payment_attempted_at::text AS payment_attempted_at, custody_pubkey, status,
   nft_mint, nft_name, nft_image, grade, insured_value_e6::text AS insured_value_e6, rarity, nft_market_id, nft_year, turbo_refund_e6::text AS turbo_refund_e6, created_at::text AS created_at`;

/** CC's provably-fair verify link for an open, or null before a memo exists. */
const verifyUrlFor = (memo: string | null): string | null => (memo ? ccVerifyUrl(memo) : null);

const rowToResult = (r: OpenRow): OpenResult => ({
  openId: r.id,
  status: r.status,
  card: r.nft_mint
    ? { mint: r.nft_mint, name: r.nft_name, grade: r.grade, imageUrl: r.nft_image, valueE6: r.insured_value_e6 ?? '0', rarity: r.rarity, marketId: r.nft_market_id, year: r.nft_year }
    : null,
  verifyUrl: verifyUrlFor(r.cc_memo),
  turboRefundE6: r.turbo_refund_e6,
});

/** Best-effort match of a won CC card to a tradeable GDEX market (P3 trade tie-in). CC names carry year/#/grade,
 *  so match a market whose display_name is a substring of the card name (longest wins). Often null — most CC
 *  cards aren't in GDEX's featured universe; the Trade CTA only shows when matched. */
async function matchMarket(q: Queryer, cardName: string | null): Promise<string | null> {
  if (!cardName) return null;
  const r = await q.query<{ id: string }>(
    `SELECT id FROM markets WHERE kind = 'card' AND status IN ('active','reduce_only') AND length(display_name) >= 4
       AND position(lower(display_name) in lower($1)) > 0 ORDER BY length(display_name) DESC LIMIT 1`,
    [cardName],
  );
  return r.rows[0]?.id ?? null;
}

// ── reveal-metadata extraction (the won card's name/grade/value come from CC's openPack response) ──
function attr(reveal: CcOpenResult, key: string): string | null {
  const hit = (reveal.nftWon?.content?.metadata?.attributes ?? []).find((x) => (x.trait_type ?? '').toLowerCase() === key.toLowerCase());
  return hit && hit.value != null ? String(hit.value) : null;
}
export function extractCard(reveal: CcOpenResult): {
  mint: string; name: string | null; grade: string | null; imageUrl: string | null; insuredValueE6: string; year: string | null; setName: string | null; rarity: string | null;
} {
  const company = attr(reveal, 'Grading Company');
  // The grade number is on 'GradeNum' for some cards, but many CC cards only carry 'The Grade' (e.g.
  // "GEM-MT 10", "GEM MINT 10", "GEM-MT 8.5") — pull the numeric grade out of that as a fallback so we
  // don't drop it and render a bare "PSA" instead of "PSA 10".
  const num = attr(reveal, 'GradeNum') ?? attr(reveal, 'Grade') ?? attr(reveal, 'The Grade')?.match(/\d+(\.\d+)?/)?.[0] ?? null;
  const grade = company ? `${company} ${num ?? ''}`.trim() : num;
  const insured = Number(attr(reveal, 'insured value') ?? attr(reveal, 'Insured Value') ?? 0);
  return {
    mint: reveal.nft_address ?? '',
    name: reveal.nftWon?.content?.metadata?.name ?? null,
    grade: grade || null,
    imageUrl: reveal.nftWon?.content?.links?.image ?? null,
    insuredValueE6: usdc(Number.isFinite(insured) ? insured : 0).toString(),
    year: attr(reveal, 'Year'),
    setName: attr(reveal, 'Set'),
    rarity: reveal.rarity ?? null,
  };
}

async function getOpenRow(db: Db, openId: string): Promise<OpenRow | null> {
  const r = await db.query<OpenRow>(`SELECT ${OPEN_COLS} FROM gacha_pack_opens WHERE id = $1`, [openId]);
  return r.rows[0] ?? null;
}


// ─────────────────────────────── open ───────────────────────────────
export async function openPack(db: Db, userId: string, opts: { machineCode: string; idempotencyKey: string; expectedPriceE6?: string; payWith?: 'usdc' | 'gold'; turbo?: boolean; claim?: boolean }, deps: GachaDeps): Promise<OpenResult> {
  if (!config.classicGachaEnabled) throw GACHA_OFF();
  const payWith = opts.payWith === 'gold' ? 'gold' : 'usdc';
  const turbo = opts.turbo === true; // YOLO: CC auto-sells a Common for instant USDC instead of delivering the slab
  const cc = deps.cc ?? defaultCcClient;
  const { chain } = deps;

  const machine = (await cc.getMachines()).machines?.find((m) => m.code === opts.machineCode);
  if (!machine) throw new HttpError(404, 'unknown machine');
  const price = usdc(machine.price); // $ → micro-USDC (CC's base price — what we pay CC on-chain)
  if (price <= 0n) throw new HttpError(503, 'machine price unavailable');
  // Gold spend gates: the master switch + the pay-with-Gold toggle, with a free-pack-claim exception — the $25
  // reward pack is claimable with Gold whenever the master is on, even if general pay-with-Gold is off (spec §6b).
  if (payWith === 'gold') {
    if (!gachaConfig.goldEnabled.get()) throw new HttpError(403, 'Gold is not enabled', 'gold_disabled');
    if (opts.claim !== true && !gachaConfig.payWithGoldEnabled.get()) throw new HttpError(403, 'paying with Gold is not available', 'pay_with_gold_off');
    if (opts.claim === true && goldPriceForPack(price) !== FREE_PACK_GOLD) throw new HttpError(403, 'a free-pack claim is the $25 pack only', 'not_free_pack');
  }
  // Optional GDEX markup over CC's price (USDC buys only; default 0 = no change). The user pays `allIn`; CC still
  // gets `price`; GDEX keeps `markup` as FEE_REVENUE (spec §6 — the "turn on if sell-back drops" lever).
  const markup = payWith === 'usdc' ? gachaMarkupE6(price, gachaConfig.markupBps.get()) : 0n;
  const allIn = price + markup;
  // No surprise charge: reject if the (marked-up) price drifted >2% above what the client displayed (spec §9).
  if (opts.expectedPriceE6 && allIn > (BigInt(opts.expectedPriceE6) * 102n) / 100n) throw new HttpError(409, 'pack price changed — refresh and try again', 'price_drift');

  const custody = await getNftCustodyKeypair(db, userId);
  const custodyPubkey = custody.publicKey.toBase58();

  // Receipt-first + debit, one tx, idempotency-anchored on (user, key).
  const anchor = await db.tx(async (q) => {
    const id = randomUUID();
    const ins = await q.query<{ id: string }>(
      `INSERT INTO gacha_pack_opens(id, user_id, idempotency_key, machine_code, price_e6, markup_e6, custody_pubkey, paid_with, turbo, status)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending') ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING id`,
      [id, userId, opts.idempotencyKey, opts.machineCode, (payWith === 'usdc' ? allIn : price).toString(), (payWith === 'usdc' ? markup : 0n).toString(), custodyPubkey, payWith, turbo],
    );
    if (!ins.rows[0]) {
      const ex = await q.query<OpenRow>(`SELECT ${OPEN_COLS} FROM gacha_pack_opens WHERE user_id = $1 AND idempotency_key = $2`, [userId, opts.idempotencyKey]);
      if (!ex.rows[0]) throw new HttpError(409, 'that idempotency key was already used');
      return { duplicate: true as const, row: ex.rows[0] };
    }
    const treasury = await getOrCreateSystemAccount(q, 'TREASURY_USDC');
    if (payWith === 'gold') {
      // Gold-bought pack: debit the player's loyalty Gold; GDEX still pays CC real USDC — from the rewards
      // budget (NOT USER_COLLATERAL, NOT FEE_REVENUE). Gold opens earn nothing (anti-abuse, spec §6b).
      await spendGold(q, userId, goldPriceForPack(price), { refType: 'gacha_open', refId: id });
      const budget = await getOrCreateSystemAccount(q, 'GACHA_REWARDS_BUDGET');
      await postTxn(q, {
        reason: 'PACK_BUY_GOLD_FUND', refType: 'gacha_open', refId: id,
        entries: [{ accountId: budget, amount: -price }, { accountId: treasury, amount: price }],
      });
    } else {
      const coll = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
      const lock = await q.query<{ amount_uusdc: string }>(`SELECT amount_uusdc FROM balances WHERE account_id = $1 FOR UPDATE`, [coll]);
      const avail = lock.rows[0] ? BigInt(lock.rows[0].amount_uusdc) : 0n;
      if (avail < allIn) throw new HttpError(400, 'insufficient balance', 'insufficient_balance');
      // user pays allIn; CC's base goes to treasury; any markup is GDEX revenue (entry omitted when markup=0).
      const entries = [{ accountId: coll, amount: -allIn }, { accountId: treasury, amount: price }];
      const feeAcc = markup > 0n ? await getOrCreateSystemAccount(q, 'FEE_REVENUE') : null;
      if (feeAcc) entries.push({ accountId: feeAcc, amount: markup });
      await postTxn(q, { reason: 'GACHA_PACK_BUY', refType: 'gacha_open', refId: id, entries });
      if (feeAcc) await accrueGachaAffiliateShare(q, userId, feeAcc, markup, id); // affiliate share of the pack markup
      // Loyalty earn — only on paid (USDC) opens (spec §6b); floored, derived from the admin threshold knob.
      await earnGold(q, userId, goldEarnedForOpen(price, gachaConfig.freePackThresholdUsd.get()), 'PACK_OPEN_EARN', { refType: 'gacha_open', refId: id });
    }
    await q.query(`UPDATE gacha_pack_opens SET status = 'paid' WHERE id = $1`, [id]);
    return { duplicate: false as const, id };
  });
  if (anchor.duplicate) return rowToResult(anchor.row);
  const openId = anchor.id;

  // Pay CC (off the tx). Never throw past the receipt — money safety is the reconciler's job.
  let attempted = false; // flips true only once the payment_attempted_at marker is persisted (i.e. about to pay CC)
  try {
    // generatePack is the live stock gate AND has no on-chain effect, so build it FIRST: a sold-out / network
    // failure (the common case) leaves a no-memo, no-payment row — nothing reached CC. Only after the memo is
    // stored do we move money (fund → sign → submit), and we stamp payment_attempted_at right before submit so
    // a failure up to that point is provably "no money reached CC".
    // In turbo, route a Common win's auto-sell USDC to the HOT wallet (altFundsRecipient) — matching
    // settleTurboSold's TREASURY debit and the manual sell-back's altRecipient. altFundsRecipient is turbo-only
    // and is IGNORED by CC for non-turbo packs, so this never touches normal mode (and a turbo non-Common card
    // still lands in the user's custody, where deliverOpen records it).
    const gen = await cc.generatePack({ playerAddress: custodyPubkey, packType: opts.machineCode, turbo, ...(turbo ? { altFundsRecipient: chain.hotPubkey() } : {}) });
    await db.query(`UPDATE gacha_pack_opens SET cc_memo = $2 WHERE id = $1`, [openId, gen.memo]);
    await chain.fundCustody(custodyPubkey, price);
    const signed = chain.signTx(gen.transaction, custody);
    await db.query(`UPDATE gacha_pack_opens SET payment_attempted_at = now() WHERE id = $1`, [openId]);
    attempted = true; // marker persisted → submit may now broadcast → never auto-refund past here
    const submit = await cc.submitTransaction(signed);
    if (submit.signature) await db.query(`UPDATE gacha_pack_opens SET payment_sig = $2 WHERE id = $1`, [openId, submit.signature]);
  } catch {
    // Pre-payment failure (sold-out generatePack / fund / sign): no money reached CC → refund NOW so a sold-out
    // machine is a clean "refunded, no funds left your balance" with no 90s wait. If the payment WAS attempted
    // (submit may have broadcast), hand to the reconciler — it only refunds once CC confirms refunded.
    if (!attempted) return await settleRefund(db, openId, 'failed');
    return await reconcileOne(db, openId, deps);
  }
  return await deliverOpen(db, openId, deps);
}

// Reveal + record (retry for CC's payment webhook lag); hand off to the reconciler if still pending.
/** #6: has CC's turbo auto-sell buyback for this memo actually LANDED on-chain? CC settles buybacks async via
 *  webhook and the openPack response carries no confirmation, so we verify through pack-status — a buyback row
 *  reported webhook_confirmed / status 'complete'. Gates the turbo credit (mirror of the manual sell-back fix) so
 *  we never credit USDC that never reached the hot wallet. A turbo Common has exactly one (auto-sell) buyback. */
async function turboBuybackLanded(cc: Pick<CcClient, 'getPackStatus'>, memo: string | null): Promise<boolean> {
  if (!memo) return false;
  const st = await cc.getPackStatus(memo).catch(() => null);
  return !!st?.buyback?.some((b) => (b.webhook_confirmed === true || b.status === 'complete') && b.refund_amount != null && Number(b.refund_amount) > 0);
}

async function deliverOpen(db: Db, openId: string, deps: GachaDeps): Promise<OpenResult> {
  const cc = deps.cc ?? defaultCcClient;
  const sleepFn = deps.sleepMs ?? sleep;
  const row = await getOpenRow(db, openId);
  if (!row) throw new HttpError(404, 'open not found');
  if (row.status !== 'paid') return rowToResult(row);
  if (!row.cc_memo) return rowToResult(row); // no memo → reconciler handles
  for (let attempt = 0; attempt < MAX_REVEAL_ATTEMPTS; attempt++) {
    const reveal = await cc.openPackReveal(row.cc_memo);
    // TURBO Common auto-sell — checked BEFORE nft_address ON PURPOSE: CC's TURBO_MODE_BUYBACK response also
    // carries nft_address (+ transactionSignature, per the gacha API docs), so an nft_address-first check would
    // mis-record an auto-sold Common as a delivered slab and never credit the buyback. Credit the buyback minus
    // the turbo cut → turbo_sold. (Normal mode + a turbo NON-Common never carry buybackAmount, so they fall
    // through to the delivery branch — this reorder cannot change their behaviour.)
    if ((reveal.code === 'TURBO_MODE_BUYBACK' || reveal.buybackAmount != null) && Number(reveal.buybackAmount) > 0) {
      const buyback = reveal.buybackAmount as number;
      // #6: NEVER credit a turbo auto-sell until CC confirms the buyback USDC actually landed. The openPack
      // response carries no confirmation and CC settles buybacks async via webhook, so verify via pack-status.
      // Poll briefly (the reveal animation covers it); if still unconfirmed, leave the open 'paid' — reconcileOne
      // re-reveals (CC's idempotent "Already Opened" returns the same buyback) and settles once it confirms,
      // exactly like a WAITING reveal. Mirrors the manual sell-back fix: never credit an unconfirmed transfer.
      for (let c = 0; c < TURBO_CONFIRM_ATTEMPTS; c++) {
        if (await turboBuybackLanded(cc, row.cc_memo)) return await settleTurboSold(db, openId, buyback);
        if (c < TURBO_CONFIRM_ATTEMPTS - 1) await sleepFn(REVEAL_RETRY_MS);
      }
      return rowToResult(row); // unconfirmed → stays 'paid' for the reconciler to settle once CC confirms
    }
    if (reveal.nft_address) {
      // A re-circulated mint (a prior holder sold it back → its row is 'sold') is a legit re-roll — deliver it.
      // But if this exact mint is CURRENTLY actively held (held/withdrawing), the on-chain NFT can't also be ours
      // → phantom delivery; refund rather than record a card the customer doesn't actually hold. (recordReveal's
      // partial-unique index is the atomic backstop against a race.)
      const heldElsewhere = (await db.query(`SELECT 1 FROM gacha_nft_inventory WHERE mint = $1 AND status IN ('held','withdrawing') LIMIT 1`, [reveal.nft_address])).rows[0];
      if (heldElsewhere) {
        console.error('[gacha] reveal mint already actively held — phantom delivery, refunding open', openId, reveal.nft_address);
        return await settleRefund(db, openId, 'failed');
      }
      return await recordReveal(db, openId, reveal); // delivered slab (normal mode + turbo non-Common)
    }
    if (reveal.code === 'WAITING_FOR_WEBHOOK') {
      if (attempt < MAX_REVEAL_ATTEMPTS - 1) { await sleepFn(REVEAL_RETRY_MS); continue; }
      break; // still waiting after retries → leave 'paid' for the reconciler
    }
    // No NFT, not waiting, no usable buyback signal → can't settle; refund rather than strand.
    console.error('[gacha] non-deliverable reveal — refunding open', openId, { code: reveal.code ?? null, buybackAmount: reveal.buybackAmount ?? null });
    return await settleRefund(db, openId, 'failed');
  }
  return rowToResult((await getOpenRow(db, openId))!); // still 'paid' (waiting) → reconciler finishes it
}

/** YOLO/turbo: CC auto-sold the Common for `buybackAmount` (base units == micro-USDC). Credit the user the
 *  payout (minus the turbo cut), book the cut to FEE_REVENUE, debit TREASURY; status → turbo_sold. No NFT,
 *  idempotent from 'paid'. (The auto-sell USDC lands in the HOT wallet via the altFundsRecipient passed at
 *  generatePack — same as the manual sell-back's altRecipient — so the TREASURY debit is backed.) */
async function settleTurboSold(db: Db, openId: string, buybackAmount: number): Promise<OpenResult> {
  const gross = BigInt(Math.trunc(buybackAmount));
  return await db.tx(async (q) => {
    const row = (await q.query<OpenRow>(`SELECT ${OPEN_COLS} FROM gacha_pack_opens WHERE id = $1 FOR UPDATE`, [openId])).rows[0];
    if (!row) throw new HttpError(404, 'open not found');
    if (row.status !== 'paid') return rowToResult(row); // settle once
    const cut = (gross * BigInt(gachaConfig.turboCutBps.get())) / 10000n; // 10% turbo cut → FEE_REVENUE (live knob)
    const payout = gross - cut;
    const coll = await getOrCreateUserAccount(q, row.user_id, 'USER_COLLATERAL');
    const treasury = await getOrCreateSystemAccount(q, 'TREASURY_USDC');
    const fee = await getOrCreateSystemAccount(q, 'FEE_REVENUE');
    await postTxn(q, {
      reason: 'GACHA_TURBO_SELL', refType: 'gacha_open', refId: openId,
      entries: [{ accountId: coll, amount: payout }, { accountId: fee, amount: cut }, { accountId: treasury, amount: -gross }],
    });
    await accrueGachaAffiliateShare(q, row.user_id, fee, cut, openId); // affiliate share of the turbo sell-back cut
    await q.query(`UPDATE gacha_pack_opens SET status = 'turbo_sold', turbo_refund_e6 = $2, settled_at = now() WHERE id = $1`, [openId, payout.toString()]);
    return { openId, status: 'turbo_sold', verifyUrl: verifyUrlFor(row.cc_memo), card: null, turboRefundE6: payout.toString() };
  });
}

/**
 * One-off recovery for the pre-fix YOLO/turbo bug: CC auto-sold a Common (TURBO_MODE_BUYBACK) but the old
 * nft_address-first `deliverOpen` recorded it as a delivered `held` slab — the open stayed 'opened' and the user
 * was never credited. This retroactively books the auto-sell EXACTLY as `settleTurboSold` would have: credit the
 * user the buyback minus the turbo cut, book the cut to FEE_REVENUE, debit TREASURY by the gross (the gross USDC
 * is swept custody→hot separately so the TREASURY debit stays backed), flip the open to 'turbo_sold', and retire
 * the phantom inventory row to 'sold'. `grossE6` is CC's CONFIRMED buyback amount (base units) for the prize's
 * open — the caller fetches + verifies it. Strictly guarded + idempotent: it acts ONLY on a turbo Common still in
 * the exact mis-recorded state, and a re-run (already 'turbo_sold'/'sold') is a no-op. `dryRun` computes without
 * writing. The double-entry (coll +payout, fee +cut, treasury −gross) sums to zero, identical to a normal turbo sell.
 */
export async function remediateMisrecordedTurboCommon(
  db: Db, prizeId: string, grossE6: bigint, opts: { dryRun?: boolean } = {},
): Promise<{ status: 'applied' | 'already_done' | 'dry_run'; openId: string; userId: string; grossE6: string; payoutE6: string; cutE6: string }> {
  if (grossE6 <= 0n) throw new HttpError(400, 'gross must be positive');
  return await db.tx(async (q) => {
    const inv = (await q.query<{ open_id: string; user_id: string; status: string }>(
      `SELECT open_id, user_id, status FROM gacha_nft_inventory WHERE id = $1 FOR UPDATE`, [prizeId])).rows[0];
    if (!inv) throw new HttpError(404, 'prize not found');
    const open = (await q.query<{ id: string; status: string; turbo: boolean; rarity: string | null; turbo_refund_e6: string | null }>(
      `SELECT id, status, turbo, rarity, turbo_refund_e6 FROM gacha_pack_opens WHERE id = $1 FOR UPDATE`, [inv.open_id])).rows[0];
    if (!open) throw new HttpError(404, 'open not found');

    const cut = (grossE6 * BigInt(gachaConfig.turboCutBps.get())) / 10000n; // same 10% turbo knob as settleTurboSold
    const payout = grossE6 - cut;

    // Idempotent: already remediated → no-op (report the prior payout, don't double-credit).
    if (open.status === 'turbo_sold' && inv.status === 'sold') {
      return { status: 'already_done', openId: open.id, userId: inv.user_id, grossE6: grossE6.toString(), payoutE6: open.turbo_refund_e6 ?? payout.toString(), cutE6: cut.toString() };
    }
    // Refuse anything not in the EXACT mis-recorded state — never touch a normal held card or an already-settled open.
    if (!open.turbo || open.rarity !== 'Common' || open.status !== 'opened' || open.turbo_refund_e6 !== null || inv.status !== 'held') {
      throw new HttpError(409, `prize ${prizeId} not in mis-recorded turbo-Common state (open=${open.status}/${open.rarity}/turbo=${open.turbo}/refund=${open.turbo_refund_e6 ?? 'null'}, inv=${inv.status})`);
    }
    if (opts.dryRun) {
      return { status: 'dry_run', openId: open.id, userId: inv.user_id, grossE6: grossE6.toString(), payoutE6: payout.toString(), cutE6: cut.toString() };
    }
    const coll = await getOrCreateUserAccount(q, inv.user_id, 'USER_COLLATERAL');
    const fee = await getOrCreateSystemAccount(q, 'FEE_REVENUE');
    const treasury = await getOrCreateSystemAccount(q, 'TREASURY_USDC');
    const txnId = await postTxn(q, {
      reason: 'GACHA_TURBO_SELL', refType: 'gacha_open', refId: open.id,
      entries: [{ accountId: coll, amount: payout }, { accountId: fee, amount: cut }, { accountId: treasury, amount: -grossE6 }],
    });
    await q.query(`UPDATE gacha_pack_opens SET status='turbo_sold', turbo_refund_e6=$2, settled_at=now() WHERE id=$1`, [open.id, payout.toString()]);
    await q.query(`UPDATE gacha_nft_inventory SET status='sold', sell_value_e6=$2, sell_cut_e6=$3, txn_id=$4, settled_at=now() WHERE id=$1`, [prizeId, payout.toString(), cut.toString(), txnId]);
    return { status: 'applied', openId: open.id, userId: inv.user_id, grossE6: grossE6.toString(), payoutE6: payout.toString(), cutE6: cut.toString() };
  });
}

async function recordReveal(db: Db, openId: string, reveal: CcOpenResult): Promise<OpenResult> {
  const card = extractCard(reveal);
  return await db.tx(async (q) => {
    const cur = (await q.query<OpenRow>(`SELECT ${OPEN_COLS} FROM gacha_pack_opens WHERE id = $1 FOR UPDATE`, [openId])).rows[0];
    if (!cur) throw new HttpError(404, 'open not found');
    if (cur.status !== 'paid') return rowToResult(cur); // already delivered (idempotent)
    const marketId = await matchMarket(q, card.name); // best-effort GDEX market for the trade tie-in (often null)
    await q.query(
      `INSERT INTO gacha_nft_inventory(id, user_id, open_id, mint, custody_pubkey, name, grade, set_name, year, image_url, insured_value_e6, market_id, status)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'held') ON CONFLICT (open_id) DO NOTHING`,
      [randomUUID(), cur.user_id, openId, card.mint, cur.custody_pubkey, card.name, card.grade, card.setName, card.year, card.imageUrl, card.insuredValueE6, marketId],
    );
    await q.query(
      `UPDATE gacha_pack_opens SET status='opened', nft_mint=$2, nft_name=$3, nft_image=$4, grade=$5, insured_value_e6=$6, rarity=$7, nft_market_id=$8, nft_year=$9, opened_at=now() WHERE id=$1`,
      [openId, card.mint, card.name, card.imageUrl, card.grade, card.insuredValueE6, card.rarity, marketId, card.year],
    );
    return { openId, status: 'opened', verifyUrl: verifyUrlFor(cur.cc_memo), card: { mint: card.mint, name: card.name, grade: card.grade, imageUrl: card.imageUrl, valueE6: card.insuredValueE6, rarity: card.rarity, marketId, year: card.year } };
  });
}

// ─────────────────────────────── reconcile / refund ───────────────────────────────
async function reconcileOne(db: Db, openId: string, deps: GachaDeps): Promise<OpenResult> {
  const cc = deps.cc ?? defaultCcClient;
  const nowMs = (deps.now ?? Date.now)();
  const row = await getOpenRow(db, openId);
  if (!row) throw new HttpError(404, 'open not found');
  if (row.status !== 'paid') return rowToResult(row);
  const ageMs = nowMs - new Date(row.created_at).getTime();
  const aged = ageMs >= RECONCILE_GRACE_MS;

  // Never reached the CC payment (no attempt marker, no sig): a sold-out generatePack, or a pre-submit fund/sign
  // failure that stored a memo but never paid → no money reached CC → refund. Aged-guarded so the async sweep
  // can't refund an open that's still mid-flight (between the receipt and submit) in a live request.
  if (!row.payment_attempted_at && !row.payment_sig) {
    return aged ? await settleRefund(db, openId, 'failed') : rowToResult(row);
  }

  // Payment was attempted (marker or sig set) → the tx may have landed. Try to deliver; only refund if CC
  // explicitly confirms the pack was refunded (never auto-fail a maybe-paid buy).
  if (row.cc_memo) {
    const delivered = await deliverOpen(db, openId, deps).catch(() => null);
    if (delivered && delivered.status !== 'paid') return delivered;
    if (aged) {
      try {
        const st = await cc.getPackStatus(row.cc_memo);
        if (st.pack?.refunded) return await settleRefund(db, openId, 'refunded');
        // Never-landed payment: well past the blockhash window CC STILL reports no confirmed purchase for this memo.
        // The per-memo `status !== 'confirmed'` check is the real guard against refunding a payment that landed; the
        // custody-balance check is a backstop (the custody is per-USER, so its funds may belong to another open). The
        // broadcast expired without paying CC → refund the buyer. Once this open leaves 'paid', autoSweepCustodyLeftovers
        // reclaims the funding (it skips users with a live 'paid' open).
        const unlanded = ageMs >= RECONCILE_UNLANDED_MS;
        if (unlanded && st.pack?.status !== 'confirmed' && row.custody_pubkey) {
          const bal = (await deps.chain.custodyUsdcBalances([row.custody_pubkey]))[row.custody_pubkey] ?? 0n;
          if (bal > 0n) return await settleRefund(db, openId, 'failed');
        }
      } catch {
        /* CC or chain RPC unreachable, or the refund tx failed — leave 'paid', retry next pass */
      }
    }
  }
  return rowToResult((await getOpenRow(db, openId)) ?? row);
}

async function settleRefund(db: Db, openId: string, finalStatus: 'refunded' | 'failed'): Promise<OpenResult> {
  return await db.tx(async (q) => {
    const row = (await q.query<OpenRow>(`SELECT ${OPEN_COLS} FROM gacha_pack_opens WHERE id = $1 FOR UPDATE`, [openId])).rows[0];
    if (!row) throw new HttpError(404, 'open not found');
    if (row.status !== 'paid') return rowToResult(row); // refund only ONCE, from 'paid' (idempotent)
    const treasury = await getOrCreateSystemAccount(q, 'TREASURY_USDC');
    const price = BigInt(row.price_e6);
    if (row.paid_with === 'gold') {
      // Gold-bought pack: return the Gold the user spent + reverse the rewards-budget funding. NEVER credit
      // USDC for a Gold purchase (that would mint money). Mirrors the PACK_BUY_GOLD_FUND posting in reverse.
      await earnGold(q, row.user_id, goldPriceForPack(price), 'PACK_REFUND_GOLD', { refType: 'gacha_open', refId: openId });
      const budget = await getOrCreateSystemAccount(q, 'GACHA_REWARDS_BUDGET');
      await postTxn(q, {
        reason: 'GACHA_REFUND', refType: 'gacha_open', refId: openId,
        entries: [{ accountId: budget, amount: price }, { accountId: treasury, amount: -price }],
      });
    } else {
      // Reverse the buy EXACTLY. The buyer paid `price` (= allIn); the GACHA_PACK_BUY split it: the CC base
      // (price − markup) → TREASURY, and any GDEX markup → FEE_REVENUE. So refund the full allIn to the buyer but
      // pull ONLY the CC base back from TREASURY and reverse the markup out of FEE_REVENUE — otherwise the markup
      // would sit in FEE_REVENUE unbacked while TREASURY over-drained, a proof-of-reserves leak. The affiliate's
      // share of the markup (already paid out, maybe spent) is NOT clawed back; FEE_REVENUE absorbs it, which stays
      // balanced (no reserve leak). markup is 0 unless the markup knob is on, so this is a no-op for un-marked buys.
      const markup = BigInt(row.markup_e6);
      const coll = await getOrCreateUserAccount(q, row.user_id, 'USER_COLLATERAL');
      const entries = [{ accountId: coll, amount: price }, { accountId: treasury, amount: -(price - markup) }];
      if (markup > 0n) entries.push({ accountId: await getOrCreateSystemAccount(q, 'FEE_REVENUE'), amount: -markup });
      await postTxn(q, { reason: 'GACHA_REFUND', refType: 'gacha_open', refId: openId, entries });
      // Gold is earned at payment (PACK_OPEN_EARN); a refunded open earned nothing, so claw the Gold back too.
      await reverseEarnedGold(q, row.user_id, openId);
    }
    await q.query(`UPDATE gacha_pack_opens SET status = $2, settled_at = now() WHERE id = $1`, [openId, finalStatus]);
    return { openId, status: finalStatus, card: null, verifyUrl: null };
  });
}

/** Sweep the caller's stranded 'paid' opens (fire-and-forget on lobby load + after an open). */
export async function reconcilePending(db: Db, userId: string, deps: GachaDeps): Promise<{ recovered: number }> {
  const rows = (await db.query<{ id: string }>(
    `SELECT id FROM gacha_pack_opens WHERE user_id = $1 AND status = 'paid' ORDER BY created_at ASC LIMIT 25`,
    [userId],
  )).rows;
  let recovered = 0;
  for (const r of rows) {
    const res = await reconcileOne(db, r.id, deps).catch(() => null);
    if (res && res.status !== 'paid') recovered++;
  }
  return { recovered };
}

/**
 * Unattended backstop sweep: reconcile EVERY user's stranded 'paid' opens, not just the caller's. A hard crash
 * between fund-custody and the CC submit leaves a buy charged-but-undelivered AND the JIT funding parked in the
 * custody wallet; reconcileOne refunds an aged open that never reached CC (or delivers/refunds one that did).
 * Without this, such an open only healed when THAT specific user happened to reload the lobby (reconcilePending).
 * Only opens older than the grace are touched (a live in-flight open is never raced); status-guarded + idempotent
 * → safe on boot, on a timer, and on any number of instances. Returns counts for the boot/loop log.
 */
export async function reconcileAllPending(db: Db, deps: GachaDeps, opts: { limit?: number } = {}): Promise<{ scanned: number; recovered: number }> {
  const cutoff = new Date((deps.now ?? Date.now)() - RECONCILE_GRACE_MS).toISOString();
  const rows = (await db.query<{ id: string }>(
    `SELECT id FROM gacha_pack_opens WHERE status = 'paid' AND created_at < $1 ORDER BY created_at ASC LIMIT $2`,
    [cutoff, opts.limit ?? 200],
  )).rows;
  let recovered = 0;
  for (const r of rows) {
    const res = await reconcileOne(db, r.id, deps).catch(() => null);
    if (res && res.status !== 'paid') recovered++;
  }
  return { scanned: rows.length, recovered };
}

export interface CustodyLeftover { userId: string; custodyPubkey: string; e6: string }

/**
 * Read-only: which RESOLVED-user custodies hold leftover USDC (stranded JIT-funding a crashed open left behind).
 * Only users with NO unresolved 'paid'/'pending' open are scanned, so a live open's funding is never reported or
 * swept — the receipt marks the open 'paid' BEFORE fund-custody runs, so the guard always sees it. Batched
 * balance read (one getMultipleAccounts per 100). Used by the admin panel + as the basis for the auto-sweep.
 */
export async function scanCustodyLeftovers(db: Db, deps: GachaDeps): Promise<{ custodies: CustodyLeftover[]; totalE6: string }> {
  const rows = (await db.query<{ user_id: string; custody_pubkey: string }>(
    `SELECT DISTINCT o.user_id, o.custody_pubkey FROM gacha_pack_opens o
      WHERE o.custody_pubkey IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM gacha_pack_opens p WHERE p.user_id = o.user_id AND p.status IN ('paid','pending'))`,
  )).rows;
  if (!rows.length) return { custodies: [], totalE6: '0' };
  const balances = await deps.chain.custodyUsdcBalances(rows.map((r) => r.custody_pubkey));
  let totalE6 = 0n;
  const custodies: CustodyLeftover[] = [];
  for (const r of rows) {
    const e6 = balances[r.custody_pubkey] ?? 0n;
    if (e6 <= 0n) continue;
    totalE6 += e6;
    custodies.push({ userId: r.user_id, custodyPubkey: r.custody_pubkey, e6: e6.toString() });
  }
  return { custodies, totalE6: totalE6.toString() };
}

/**
 * Auto-sweep stranded custody USDC back to hot — flag-gated (GACHA_AUTO_SWEEP_ENABLED, OFF by default; it's
 * automated on-chain signing). Recovers the JIT funding a crashed/failed open parked in a custody, so a failure
 * self-heals on-chain (the customer's REFUND is reconcileAllPending's job — independent). Internal-only
 * (custody→hot, our own wallets). Capped per run; logs each sweep; a re-derived-keypair tripwire prevents ever
 * signing for the wrong custody. The manual scripts/sweep-custody-leftovers.ts stays the operator backstop.
 */
export async function autoSweepCustodyLeftovers(db: Db, deps: GachaDeps, opts: { maxSweeps?: number } = {}): Promise<{ scanned: number; swept: number; sweptE6: string }> {
  if (!config.gachaAutoSweepEnabled) return { scanned: 0, swept: 0, sweptE6: '0' };
  const { custodies } = await scanCustodyLeftovers(db, deps);
  const cap = opts.maxSweeps ?? 25;
  let swept = 0;
  let sweptE6 = 0n;
  for (const c of custodies) {
    if (swept >= cap) break;
    const kp = await getNftCustodyKeypair(db, c.userId);
    if (kp.publicKey.toBase58() !== c.custodyPubkey) {
      console.error('[gacha] auto-sweep custody mismatch — skip', { userId: c.userId, expected: c.custodyPubkey, derived: kp.publicKey.toBase58() });
      continue;
    }
    try {
      const { sig } = await deps.chain.sweepCustodyUsdc(kp, BigInt(c.e6));
      console.log('[gacha] auto-swept custody leftover → hot', { userId: c.userId, custody: c.custodyPubkey, usd: Number(c.e6) / 1e6, sig });
      swept++;
      sweptE6 += BigInt(c.e6);
    } catch (e) {
      console.error('[gacha] auto-sweep failed', c.custodyPubkey, e instanceof Error ? e.message : e);
    }
  }
  return { scanned: custodies.length, swept, sweptE6: sweptE6.toString() };
}

/** Poll a single open (the web polls this until the reveal lands). */
export async function getOpen(db: Db, userId: string, openId: string): Promise<OpenResult> {
  const row = await getOpenRow(db, openId);
  if (!row || row.user_id !== userId) throw new HttpError(404, 'open not found');
  return rowToResult(row);
}

// ─────────────────────────────── sell-back ───────────────────────────────
export interface InventoryItem { id: string; mint: string; name: string | null; grade: string | null; imageUrl: string | null; valueE6: string; marketId: string | null; status: string; rarity: string | null }

export async function listInventory(db: Db, userId: string): Promise<InventoryItem[]> {
  // rarity isn't on the inventory row — pull it from the linked open (LEFT JOIN so a row without an open still shows).
  const r = await db.query<{ id: string; mint: string; name: string | null; grade: string | null; image_url: string | null; insured_value_e6: string | null; market_id: string | null; status: string; rarity: string | null }>(
    `SELECT i.id, i.mint, i.name, i.grade, i.image_url, i.insured_value_e6::text AS insured_value_e6, i.market_id, i.status, o.rarity
       FROM gacha_nft_inventory i LEFT JOIN gacha_pack_opens o ON o.id = i.open_id
      WHERE i.user_id = $1 AND i.status IN ('held','withdrawing') ORDER BY i.acquired_at DESC`,
    [userId],
  );
  return r.rows.map((x) => ({ id: x.id, mint: x.mint, name: x.name, grade: x.grade, imageUrl: x.image_url, valueE6: x.insured_value_e6 ?? '0', marketId: x.market_id, status: x.status, rarity: x.rarity }));
}

export async function sellBack(db: Db, userId: string, prizeId: string, deps: GachaDeps, opts: { instant?: boolean } = {}): Promise<SellBackResult> {
  if (!config.classicGachaEnabled) throw GACHA_OFF();
  const cc = deps.cc ?? defaultCcClient;
  const { chain } = deps;
  const getInfo = deps.getAssetInfo ?? getAssetTransferInfo; // DAS owner lookup to gate the revert
  const cutBps = BigInt(opts.instant ? gachaConfig.turboCutBps.get() : gachaConfig.buybackCutBps.get()); // 10% instant vs 5% manual (live knobs)

  // Claim the prize (held → selling) under a row lock BEFORE the irreversible on-chain buyback, so two
  // concurrent sell-backs can't both submit it (the second sees 'selling', not 'held').
  const claimed = await db.tx(async (q) => {
    const row = (await q.query<{ mint: string; custody_pubkey: string; status: string }>(
      `SELECT mint, custody_pubkey, status FROM gacha_nft_inventory WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [prizeId, userId],
    )).rows[0];
    if (!row) throw new HttpError(404, 'prize not found');
    if (row.status !== 'held') throw new HttpError(409, 'prize already settled');
    // settled_at doubles as the last-state-change marker so the stuck-row reconciler can grace this claim.
    await q.query(`UPDATE gacha_nft_inventory SET status = 'selling', settled_at = now() WHERE id = $1`, [prizeId]);
    return { mint: row.mint, custodyPubkey: row.custody_pubkey };
  });

  let gross: bigint | null = null; // stays null when the buyback is broadcast but UNCONFIRMED → defer to the reconciler
  try {
    // On-chain buyback (NFT → CC, USDC → hot via altRecipient), signed by the NFT owner's custody keypair.
    const custody = await getNftCustodyKeypair(db, userId);
    const quote = await cc.buyback({ playerAddress: claimed.custodyPubkey, nftAddress: claimed.mint, altRecipient: chain.hotPubkey() });
    if (!quote.serializedTransaction) throw new HttpError(503, 'buyback unavailable for this card');
    const signed = chain.signTx(quote.serializedTransaction, custody);
    const submit = await cc.submitTransaction(signed);
    if (!submit.success && !submit.signature) throw new HttpError(502, 'buyback submission failed');
    // Settle synchronously ONLY when CC reports the broadcast CONFIRMED. A 'submitted' status (sent, not yet
    // landed — it may still confirm OR expire) — or anything not confirmed/finalized — means we must NOT credit
    // yet: paying now risks paying the seller before the USDC reaches the hot wallet, leaving the NFT in custody
    // marked 'sold' with no recovery (settled rows aren't re-scanned). Leave the row 'selling' (NOT reverted — the
    // tx may yet land) for reconcileStuckPrizes, which resolves it from the on-chain NFT owner (settle if it left
    // custody, revert to 'held' if it didn't). Lower-cased to match CC's documented status strings defensively.
    const confStatus = (submit.confirmationStatus ?? '').toLowerCase();
    if (confStatus === 'confirmed' || confStatus === 'finalized') {
      gross = BigInt(Math.trunc(quote.refundAmount)); // base units CC pays the hot wallet
    }
  } catch (e) {
    // Release the claim (selling → held) so the user can retry — but ONLY if the NFT is CONFIRMED still in
    // custody (the common pre-broadcast failure). If it has LEFT (the rare broadcast-then-timeout: the buyback
    // actually landed) or DAS is unavailable, leave the row 'selling' for the reconciler to settle on-chain.
    // Reverting to 'held' on a gone NFT would strand a sold slab as a phantom — mis-crediting the seller AND
    // (since CC re-circulates bought-back NFTs) misfiring a later open's phantom guard on the re-rolled mint.
    const info = await getInfo(claimed.mint).catch(() => null);
    if (info && info.owner === claimed.custodyPubkey) {
      await db.query(`UPDATE gacha_nft_inventory SET status = 'held' WHERE id = $1 AND status = 'selling'`, [prizeId])
        .catch((revertErr) => console.error('[gacha] sell-back revert failed — prize stuck "selling":', prizeId, revertErr));
    } else {
      console.error('[gacha] sell-back submit failed; NFT not confirmed in custody — left "selling" for the reconciler:', prizeId, claimed.mint, { owner: info?.owner ?? null });
    }
    console.error('[gacha] sell-back failed:', prizeId, e instanceof Error ? e.message : e);
    throw e;
  }

  // Unconfirmed buyback → the row stays 'selling' for reconcileStuckPrizes; don't credit the seller yet.
  if (gross === null) throw new HttpError(409, 'sell-back is processing — your balance will update shortly', 'buyback_pending');
  // Settle the ledger from the committed refund amount — shared with the reconciler's auto-settle, and accrues
  // the affiliate share of the cut inside settleSoldPrize (so live + reconciled sell-backs are consistent).
  return await db.tx((q) => settleSoldPrize(q, prizeId, userId, gross, cutBps));
}

// ─────────────────────────────── convert: sell-back → open a perp (lever C, P3) ───────────────────────────────
export interface ConvertResult { prizeId: string; payoutE6: string; cutE6: string; positionId: string | null; positionError?: string }
const CONVERT_LEVERAGE_DEFAULT = 2; // one-click default; the engine still enforces the market's own max
const CONVERT_LEVERAGE_MAX = 20; // sanity cap; openPosition rejects anything above the market's max_leverage_e2

/**
 * Convert a won slab into a GDEX perp on the same card (spec §9, lever C — only when the card matched a market).
 * TWO async stages, NOT atomic (openPosition takes its own market lock + tx, and the sell-back waits on the CC
 * buyback, so they cannot share a tx): (1) the normal sell-back settles the proceeds to USER_COLLATERAL; (2) a
 * separate openPosition on the card's market, sized so the proceeds ARE the margin. If stage 2 fails the user
 * simply keeps the USDC (reported in `positionError`); stage 1 is never rolled back.
 */
export async function convert(db: Db, userId: string, prizeId: string, deps: GachaDeps, opts: { side?: 'long' | 'short'; leverage?: number } = {}): Promise<ConvertResult> {
  if (!config.classicGachaEnabled) throw GACHA_OFF();
  const pre = (await db.query<{ market_id: string | null; status: string }>(
    `SELECT market_id, status FROM gacha_nft_inventory WHERE id = $1 AND user_id = $2`, [prizeId, userId])).rows[0];
  if (!pre) throw new HttpError(404, 'prize not found');
  if (!pre.market_id) throw new HttpError(409, 'this card has no GDEX market to convert into', 'no_market');
  if (pre.status !== 'held') throw new HttpError(409, 'prize already settled');

  const sb = await sellBack(db, userId, prizeId, deps); // stage 1 (claims the row, on-chain buyback, settles payout)

  const side = opts.side === 'short' ? 'short' : 'long';
  const leverage = Math.max(1, Math.min(CONVERT_LEVERAGE_MAX, Math.floor(opts.leverage ?? CONVERT_LEVERAGE_DEFAULT)));
  try {
    const markE6 = (await lastMarkE6(db, pre.market_id)) ?? 0n;
    if (markE6 <= 0n) throw new HttpError(400, 'no price for this market yet');
    // qty so that margin (= notional/leverage = qty·mark/leverage) equals the proceeds.
    const qtyE6 = (BigInt(sb.payoutE6) * BigInt(leverage) * 1_000_000n) / markE6;
    if (qtyE6 <= 0n) throw new HttpError(400, 'proceeds too small to open a position');
    const pos = await openPosition(db, userId, { marketId: pre.market_id, side, qtyE6, leverage, idempotencyKey: `gconv-${prizeId}` });
    return { prizeId, payoutE6: sb.payoutE6, cutE6: sb.cutE6, positionId: pos.positionId };
  } catch (e) {
    return { prizeId, payoutE6: sb.payoutE6, cutE6: sb.cutE6, positionId: null, positionError: e instanceof Error ? e.message : 'could not open the position' };
  }
}

// ─────────────────────────────── withdraw the real NFT (P2) ───────────────────────────────
/** Issue the step-up nonce/message the user signs to authorize sending a held NFT to `dest`. */
export async function nftWithdrawNonce(db: Db, userId: string, pubkey: string, prizeId: string, dest: string): Promise<{ nonce: string; message: string }> {
  if (!config.classicGachaEnabled) throw GACHA_OFF();
  const inv = (await db.query<{ mint: string; status: string }>(`SELECT mint, status FROM gacha_nft_inventory WHERE id = $1 AND user_id = $2`, [prizeId, userId])).rows[0];
  if (!inv) throw new HttpError(404, 'prize not found');
  if (inv.status !== 'held') throw new HttpError(409, 'prize not withdrawable');
  return createNftWithdrawNonce(db, pubkey, { mint: inv.mint, dest });
}

/** Withdraw a held NFT to the user's external `dest`, gated by a fresh step-up signature over (mint, dest). */
export async function requestNftWithdraw(
  db: Db, userId: string, pubkey: string, prizeId: string,
  p: { dest: string; message: string; signature: string }, deps: GachaDeps,
): Promise<{ status: string; sig?: string }> {
  if (!config.classicGachaEnabled) throw GACHA_OFF();
  const { chain } = deps;
  const getInfo = deps.getAssetInfo ?? getAssetTransferInfo; // DAS owner lookup to gate the revert
  // Claim held → withdrawing AND verify the step-up in one tx (a rollback un-claims the nonce, like the USDC
  // withdrawal). A stolen access token alone can't move the asset — the dest is bound by a fresh wallet sig.
  const claimed = await db.tx(async (q) => {
    const row = (await q.query<{ mint: string; custody_pubkey: string; status: string }>(`SELECT mint, custody_pubkey, status FROM gacha_nft_inventory WHERE id = $1 AND user_id = $2 FOR UPDATE`, [prizeId, userId])).rows[0];
    if (!row) throw new HttpError(404, 'prize not found');
    if (row.status !== 'held') throw new HttpError(409, 'prize not withdrawable');
    await verifyNftWithdrawStepUp(q, { pubkey, mint: row.mint, dest: p.dest, message: p.message, signature: p.signature });
    // settled_at = last-state-change marker (grace anchor for the stuck-row reconciler).
    await q.query(`UPDATE gacha_nft_inventory SET status = 'withdrawing', withdraw_dest = $2, settled_at = now() WHERE id = $1`, [prizeId, p.dest]);
    return { mint: row.mint, custodyPubkey: row.custody_pubkey };
  });

  let sig: string;
  try {
    const custody = await getNftCustodyKeypair(db, userId);
    ({ sig } = await chain.transferNft(claimed.mint, p.dest, custody));
  } catch (e) {
    // Release the claim (withdrawing → held) so the user can re-authorize — but ONLY if the NFT is CONFIRMED
    // still in custody. If it has LEFT (a broadcast-then-timeout: the transfer landed at dest) or DAS is
    // unavailable, leave the row 'withdrawing' for the reconciler to finalize to 'withdrawn' — reverting to
    // 'held' on an already-transferred NFT would strand a phantom (user thinks they hold a card that's gone).
    const info = await getInfo(claimed.mint).catch(() => null);
    if (info && info.owner === claimed.custodyPubkey) {
      await db
        .query(`UPDATE gacha_nft_inventory SET status = 'held', withdraw_dest = NULL WHERE id = $1 AND status = 'withdrawing'`, [prizeId])
        .catch((revertErr) => console.error('[gacha] NFT-withdraw revert failed — prize stuck "withdrawing":', prizeId, revertErr));
    } else {
      console.error('[gacha] NFT-withdraw failed; NFT not confirmed in custody — left "withdrawing" for the reconciler:', prizeId, claimed.mint, { owner: info?.owner ?? null });
    }
    throw e;
  }
  await db.query(`UPDATE gacha_nft_inventory SET status = 'withdrawn', withdraw_sig = $2, settled_at = now() WHERE id = $1 AND status = 'withdrawing'`, [prizeId, sig]);
  return { status: 'withdrawn', sig };
}
