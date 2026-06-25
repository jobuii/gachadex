import { randomUUID } from 'node:crypto';
import type { Db, Queryer } from '../db/client.ts';
import { config } from '../config.ts';
import { HttpError } from '../errors.ts';
import { usdc } from '../money.ts';
import { getOrCreateUserAccount, getOrCreateSystemAccount, postTxn } from './ledger.ts';
import { getNftCustodyKeypair } from './custody/wallet.ts';
import { createNftWithdrawNonce, verifyNftWithdrawStepUp } from './auth.ts';
import { spendTokens, earnTokens, tokensEarnedForOpen, tokenPriceForPack } from './tokens.ts';
import { gachaConfig, gachaMarkupE6 } from './gacha-config.ts';
import type { GachaChain } from './custody/gacha-chain.ts';
import { defaultCcClient, ccVerifyUrl, type CcClient, type CcOpenResult } from './providers/collectorcrypt.ts';

/**
 * Classic Gacha service (docs/classic-gacha-cc-packs-spec.md, P1–P4 — buy → open → sell-back / withdraw,
 * pay with USDC or loyalty Tokens).
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
const REVEAL_RETRY_MS = 1500;
const RECONCILE_GRACE_MS = 90_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface GachaDeps {
  chain: GachaChain;
  cc?: CcClient;
  sleepMs?: (ms: number) => Promise<void>;
  now?: () => number; // injectable clock for the reconcile grace window (tests)
}

export interface GachaCard { mint: string; name: string | null; grade: string | null; imageUrl: string | null; valueE6: string; rarity: string | null; marketId: string | null; year: string | null }
export interface OpenResult { openId: string; status: string; card: GachaCard | null; verifyUrl: string | null; turboRefundE6?: string | null; duplicate?: boolean }

interface OpenRow {
  id: string; user_id: string; machine_code: string; price_e6: string; paid_with: string; cc_memo: string | null;
  payment_sig: string | null; custody_pubkey: string | null; status: string;
  nft_mint: string | null; nft_name: string | null; nft_image: string | null; grade: string | null;
  insured_value_e6: string | null; rarity: string | null; nft_market_id: string | null; nft_year: string | null; turbo_refund_e6: string | null; created_at: string;
}

const OPEN_COLS =
  `id, user_id, machine_code, price_e6::text AS price_e6, paid_with, cc_memo, payment_sig, custody_pubkey, status,
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
  const num = attr(reveal, 'GradeNum') ?? attr(reveal, 'Grade');
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
export async function openPack(db: Db, userId: string, opts: { machineCode: string; idempotencyKey: string; expectedPriceE6?: string; payWith?: 'usdc' | 'tokens'; turbo?: boolean }, deps: GachaDeps): Promise<OpenResult> {
  if (!config.classicGachaEnabled) throw GACHA_OFF();
  const payWith = opts.payWith === 'tokens' ? 'tokens' : 'usdc';
  if (payWith === 'tokens' && !config.tokensEnabled) throw new HttpError(403, 'paying with Tokens is not available');
  const turbo = opts.turbo === true; // YOLO: CC auto-sells a Common for instant USDC instead of delivering the slab
  const cc = deps.cc ?? defaultCcClient;
  const { chain } = deps;

  const machine = (await cc.getMachines()).machines?.find((m) => m.code === opts.machineCode);
  if (!machine) throw new HttpError(404, 'unknown machine');
  const price = usdc(machine.price); // $ → micro-USDC (CC's base price — what we pay CC on-chain)
  if (price <= 0n) throw new HttpError(503, 'machine price unavailable');
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
      `INSERT INTO gacha_pack_opens(id, user_id, idempotency_key, machine_code, price_e6, custody_pubkey, paid_with, turbo, status)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending') ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING id`,
      [id, userId, opts.idempotencyKey, opts.machineCode, (payWith === 'usdc' ? allIn : price).toString(), custodyPubkey, payWith, turbo],
    );
    if (!ins.rows[0]) {
      const ex = await q.query<OpenRow>(`SELECT ${OPEN_COLS} FROM gacha_pack_opens WHERE user_id = $1 AND idempotency_key = $2`, [userId, opts.idempotencyKey]);
      if (!ex.rows[0]) throw new HttpError(409, 'that idempotency key was already used');
      return { duplicate: true as const, row: ex.rows[0] };
    }
    const treasury = await getOrCreateSystemAccount(q, 'TREASURY_USDC');
    if (payWith === 'tokens') {
      // Token-bought pack: debit the player's loyalty Tokens; GDEX still pays CC real USDC — from the rewards
      // budget (NOT USER_COLLATERAL, NOT FEE_REVENUE). Token opens earn nothing (anti-abuse, spec §6b).
      await spendTokens(q, userId, tokenPriceForPack(price), { refType: 'gacha_open', refId: id });
      const budget = await getOrCreateSystemAccount(q, 'GACHA_REWARDS_BUDGET');
      await postTxn(q, {
        reason: 'PACK_BUY_TOKENS_FUND', refType: 'gacha_open', refId: id,
        entries: [{ accountId: budget, amount: -price }, { accountId: treasury, amount: price }],
      });
    } else {
      const coll = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
      const lock = await q.query<{ amount_uusdc: string }>(`SELECT amount_uusdc FROM balances WHERE account_id = $1 FOR UPDATE`, [coll]);
      const avail = lock.rows[0] ? BigInt(lock.rows[0].amount_uusdc) : 0n;
      if (avail < allIn) throw new HttpError(400, 'insufficient balance', 'insufficient_balance');
      // user pays allIn; CC's base goes to treasury; any markup is GDEX revenue (entry omitted when markup=0).
      const entries = [{ accountId: coll, amount: -allIn }, { accountId: treasury, amount: price }];
      if (markup > 0n) entries.push({ accountId: await getOrCreateSystemAccount(q, 'FEE_REVENUE'), amount: markup });
      await postTxn(q, { reason: 'GACHA_PACK_BUY', refType: 'gacha_open', refId: id, entries });
      // Loyalty earn — only on paid (USDC) opens (spec §6b); floored, derived from the admin threshold knob.
      await earnTokens(q, userId, tokensEarnedForOpen(price, gachaConfig.freePackThresholdUsd.get()), 'PACK_OPEN_EARN', { refType: 'gacha_open', refId: id });
    }
    await q.query(`UPDATE gacha_pack_opens SET status = 'paid' WHERE id = $1`, [id]);
    return { duplicate: false as const, id };
  });
  if (anchor.duplicate) return rowToResult(anchor.row);
  const openId = anchor.id;

  // Pay CC (off the tx). Never throw past the receipt — money safety is the reconciler's job.
  try {
    // generatePack has no on-chain effect, so build it FIRST: a CC failure (sold out / network — the common
    // case) then leaves a no-memo row with no funds moved, which the reconciler refunds cleanly. Only after
    // the memo is stored do we move money (fund → sign → submit).
    const gen = await cc.generatePack({ playerAddress: custodyPubkey, packType: opts.machineCode, turbo });
    await db.query(`UPDATE gacha_pack_opens SET cc_memo = $2 WHERE id = $1`, [openId, gen.memo]);
    await chain.fundCustody(custodyPubkey, price);
    const signed = chain.signTx(gen.transaction, custody);
    const submit = await cc.submitTransaction(signed);
    if (submit.signature) await db.query(`UPDATE gacha_pack_opens SET payment_sig = $2 WHERE id = $1`, [openId, submit.signature]);
  } catch {
    return await reconcileOne(db, openId, deps); // re-checks payment_sig + CC status; refunds a no-memo buy
  }
  return await deliverOpen(db, openId, deps);
}

// Reveal + record (retry for CC's payment webhook lag); hand off to the reconciler if still pending.
async function deliverOpen(db: Db, openId: string, deps: GachaDeps): Promise<OpenResult> {
  const cc = deps.cc ?? defaultCcClient;
  const sleepFn = deps.sleepMs ?? sleep;
  const row = await getOpenRow(db, openId);
  if (!row) throw new HttpError(404, 'open not found');
  if (row.status !== 'paid') return rowToResult(row);
  if (!row.cc_memo) return rowToResult(row); // no memo → reconciler handles
  for (let attempt = 0; attempt < MAX_REVEAL_ATTEMPTS; attempt++) {
    const reveal = await cc.openPackReveal(row.cc_memo);
    if (reveal.nft_address) return await recordReveal(db, openId, reveal);
    if (reveal.code === 'WAITING_FOR_WEBHOOK') {
      if (attempt < MAX_REVEAL_ATTEMPTS - 1) { await sleepFn(REVEAL_RETRY_MS); continue; }
      break; // still waiting after retries → leave 'paid' for the reconciler
    }
    // No NFT, not waiting → CC auto-sold a Common (YOLO/turbo): code=TURBO_MODE_BUYBACK with a buybackAmount.
    // Credit the buyback minus the turbo cut → turbo_sold. A buyback signal with no usable amount can't be
    // settled, so refund rather than strand.
    if ((reveal.code === 'TURBO_MODE_BUYBACK' || reveal.buybackAmount != null) && Number(reveal.buybackAmount) > 0) {
      return await settleTurboSold(db, openId, reveal.buybackAmount as number);
    }
    console.error('[gacha] non-deliverable reveal — refunding open', openId, { code: reveal.code ?? null, buybackAmount: reveal.buybackAmount ?? null });
    return await settleRefund(db, openId, 'failed');
  }
  return rowToResult((await getOpenRow(db, openId))!); // still 'paid' (waiting) → reconciler finishes it
}

/** YOLO/turbo: CC auto-sold the Common for `buybackAmount` (base units == micro-USDC). Credit the user the
 *  payout (minus the turbo cut), book the cut to FEE_REVENUE, debit TREASURY; status → turbo_sold. No NFT,
 *  idempotent from 'paid'. (The on-chain buyback USDC lands in the custody wallet — operator sweep, like sell-back.) */
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
    await q.query(`UPDATE gacha_pack_opens SET status = 'turbo_sold', turbo_refund_e6 = $2, settled_at = now() WHERE id = $1`, [openId, payout.toString()]);
    return { openId, status: 'turbo_sold', verifyUrl: verifyUrlFor(row.cc_memo), card: null, turboRefundE6: payout.toString() };
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
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'held') ON CONFLICT (mint) DO NOTHING`,
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
  const aged = nowMs - new Date(row.created_at).getTime() >= RECONCILE_GRACE_MS;

  if (row.cc_memo) {
    const delivered = await deliverOpen(db, openId, deps).catch(() => null);
    if (delivered && delivered.status !== 'paid') return delivered;
    if (!aged) return rowToResult((await getOpenRow(db, openId)) ?? row);
    try {
      const st = await cc.getPackStatus(row.cc_memo);
      if (st.pack?.refunded) return await settleRefund(db, openId, 'refunded');
    } catch {
      /* CC unreachable — leave 'paid', try again later */
    }
    return rowToResult((await getOpenRow(db, openId)) ?? row);
  }

  // No memo → generatePack never ran. With no payment_sig, nothing reached CC → refund the buy.
  if (!row.payment_sig && aged) return await settleRefund(db, openId, 'failed');
  return rowToResult(row);
}

async function settleRefund(db: Db, openId: string, finalStatus: 'refunded' | 'failed'): Promise<OpenResult> {
  return await db.tx(async (q) => {
    const row = (await q.query<OpenRow>(`SELECT ${OPEN_COLS} FROM gacha_pack_opens WHERE id = $1 FOR UPDATE`, [openId])).rows[0];
    if (!row) throw new HttpError(404, 'open not found');
    if (row.status !== 'paid') return rowToResult(row); // refund only ONCE, from 'paid' (idempotent)
    const treasury = await getOrCreateSystemAccount(q, 'TREASURY_USDC');
    const price = BigInt(row.price_e6);
    if (row.paid_with === 'tokens') {
      // Token-bought pack: return the Tokens the user spent + reverse the rewards-budget funding. NEVER credit
      // USDC for a Token purchase (that would mint money). Mirrors the PACK_BUY_TOKENS_FUND posting in reverse.
      await earnTokens(q, row.user_id, tokenPriceForPack(price), 'PACK_REFUND_TOKENS', { refType: 'gacha_open', refId: openId });
      const budget = await getOrCreateSystemAccount(q, 'GACHA_REWARDS_BUDGET');
      await postTxn(q, {
        reason: 'GACHA_REFUND', refType: 'gacha_open', refId: openId,
        entries: [{ accountId: budget, amount: price }, { accountId: treasury, amount: -price }],
      });
    } else {
      const coll = await getOrCreateUserAccount(q, row.user_id, 'USER_COLLATERAL');
      await postTxn(q, {
        reason: 'GACHA_REFUND', refType: 'gacha_open', refId: openId,
        entries: [{ accountId: coll, amount: price }, { accountId: treasury, amount: -price }],
      });
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

/** Poll a single open (the web polls this until the reveal lands). */
export async function getOpen(db: Db, userId: string, openId: string): Promise<OpenResult> {
  const row = await getOpenRow(db, openId);
  if (!row || row.user_id !== userId) throw new HttpError(404, 'open not found');
  return rowToResult(row);
}

// ─────────────────────────────── sell-back ───────────────────────────────
export interface InventoryItem { id: string; mint: string; name: string | null; grade: string | null; imageUrl: string | null; valueE6: string; marketId: string | null; status: string }

export async function listInventory(db: Db, userId: string): Promise<InventoryItem[]> {
  const r = await db.query<{ id: string; mint: string; name: string | null; grade: string | null; image_url: string | null; insured_value_e6: string | null; market_id: string | null; status: string }>(
    `SELECT id, mint, name, grade, image_url, insured_value_e6::text AS insured_value_e6, market_id, status
       FROM gacha_nft_inventory WHERE user_id = $1 AND status IN ('held','withdrawing') ORDER BY acquired_at DESC`,
    [userId],
  );
  return r.rows.map((x) => ({ id: x.id, mint: x.mint, name: x.name, grade: x.grade, imageUrl: x.image_url, valueE6: x.insured_value_e6 ?? '0', marketId: x.market_id, status: x.status }));
}

export interface SellBackResult { prizeId: string; payoutE6: string; cutE6: string }

export async function sellBack(db: Db, userId: string, prizeId: string, deps: GachaDeps, opts: { instant?: boolean } = {}): Promise<SellBackResult> {
  if (!config.classicGachaEnabled) throw GACHA_OFF();
  const cc = deps.cc ?? defaultCcClient;
  const { chain } = deps;
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
    await q.query(`UPDATE gacha_nft_inventory SET status = 'selling' WHERE id = $1`, [prizeId]);
    return { mint: row.mint, custodyPubkey: row.custody_pubkey };
  });

  let gross: bigint;
  try {
    // On-chain buyback (NFT → CC, USDC → hot via altRecipient), signed by the NFT owner's custody keypair.
    const custody = await getNftCustodyKeypair(db, userId);
    const quote = await cc.buyback({ playerAddress: claimed.custodyPubkey, nftAddress: claimed.mint, altRecipient: chain.hotPubkey() });
    if (!quote.serializedTransaction) throw new HttpError(503, 'buyback unavailable for this card');
    const signed = chain.signTx(quote.serializedTransaction, custody);
    const submit = await cc.submitTransaction(signed);
    if (!submit.success && !submit.signature) throw new HttpError(502, 'buyback submission failed');
    gross = BigInt(Math.trunc(quote.refundAmount)); // base units CC commits to pay the hot wallet
  } catch (e) {
    // Release the claim (selling → held) so the user can retry. Most submit failures mean nothing moved (build
    // error / 4xx / pre-broadcast timeout). The rare broadcast-then-timeout leaves the NFT gone yet the row back at
    // 'held' — log so an operator can reconcile (no inventory reconciler yet; mirrors the withdraw path's logging).
    await db.query(`UPDATE gacha_nft_inventory SET status = 'held' WHERE id = $1 AND status = 'selling'`, [prizeId])
      .catch((revertErr) => console.error('[gacha] sell-back revert failed — prize stuck "selling":', prizeId, revertErr));
    console.error('[gacha] sell-back failed (released to held — verify the NFT is still in custody):', prizeId, e instanceof Error ? e.message : e);
    throw e;
  }

  // Settle the ledger from the committed refund amount.
  return await db.tx(async (q) => {
    const cur = (await q.query<{ status: string }>(`SELECT status FROM gacha_nft_inventory WHERE id = $1 FOR UPDATE`, [prizeId])).rows[0];
    if (!cur || cur.status !== 'selling') throw new HttpError(409, 'prize already settled'); // settle exactly once
    const payout = (gross * (10_000n - cutBps)) / 10_000n; // floor; user gets (1 − cut)
    const cut = gross - payout; // GDEX keeps the remainder
    const coll = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
    const fee = await getOrCreateSystemAccount(q, 'FEE_REVENUE');
    const treasury = await getOrCreateSystemAccount(q, 'TREASURY_USDC');
    const txnId = await postTxn(q, {
      reason: 'GACHA_SELLBACK', refType: 'gacha_prize', refId: prizeId,
      entries: [
        { accountId: coll, amount: payout },
        { accountId: fee, amount: cut },
        { accountId: treasury, amount: -gross }, // liability up by the USDC that landed in the hot wallet
      ],
    });
    await q.query(`UPDATE gacha_nft_inventory SET status='sold', sell_value_e6=$2, sell_cut_e6=$3, txn_id=$4, settled_at=now() WHERE id=$1`, [prizeId, payout.toString(), cut.toString(), txnId]);
    return { prizeId, payoutE6: payout.toString(), cutE6: cut.toString() };
  });
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
  // Claim held → withdrawing AND verify the step-up in one tx (a rollback un-claims the nonce, like the USDC
  // withdrawal). A stolen access token alone can't move the asset — the dest is bound by a fresh wallet sig.
  const claimed = await db.tx(async (q) => {
    const row = (await q.query<{ mint: string; status: string }>(`SELECT mint, status FROM gacha_nft_inventory WHERE id = $1 AND user_id = $2 FOR UPDATE`, [prizeId, userId])).rows[0];
    if (!row) throw new HttpError(404, 'prize not found');
    if (row.status !== 'held') throw new HttpError(409, 'prize not withdrawable');
    await verifyNftWithdrawStepUp(q, { pubkey, mint: row.mint, dest: p.dest, message: p.message, signature: p.signature });
    await q.query(`UPDATE gacha_nft_inventory SET status = 'withdrawing', withdraw_dest = $2 WHERE id = $1`, [prizeId, p.dest]);
    return { mint: row.mint };
  });

  let sig: string;
  try {
    const custody = await getNftCustodyKeypair(db, userId);
    ({ sig } = await chain.transferNft(claimed.mint, p.dest, custody));
  } catch (e) {
    // Release the claim (withdrawing → held) so the user can re-authorize. If the revert ITSELF fails, surface
    // it (don't swallow) — the row is then stuck 'withdrawing' with the NFT still in custody, an operator fix.
    await db
      .query(`UPDATE gacha_nft_inventory SET status = 'held', withdraw_dest = NULL WHERE id = $1 AND status = 'withdrawing'`, [prizeId])
      .catch((revertErr) => console.error('[gacha] NFT-withdraw revert failed — prize stuck "withdrawing", NFT still in custody:', prizeId, revertErr));
    throw e;
  }
  await db.query(`UPDATE gacha_nft_inventory SET status = 'withdrawn', withdraw_sig = $2, settled_at = now() WHERE id = $1 AND status = 'withdrawing'`, [prizeId, sig]);
  return { status: 'withdrawn', sig };
}
