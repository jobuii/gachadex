import type { FastifyInstance } from 'fastify';
import { SetPriceRequest, InsuranceFundRequest, FeeRequest, FundingFactorRequest, MarkClampRequest, LpSharePctRequest, WithdrawalAutoProcessRequest, ChatModActionRequest, ChatThresholdsRequest, DropConfigRequest, GameConfigRequest, GamePoolSeedRequest, BreakCancelRequest, ArenaCancelRequest } from '@pokex/shared-types';
import { config } from '../config.ts';
import { HttpError } from '../errors.ts';
import { getDb } from '../db/client.ts';
import { rl } from './_ratelimit.ts';
import { requireAdminKey } from './admin.ts';
import { gachaAdminConfig, setGachaConfig } from '../services/gacha-config.ts';
import { gachaMonitoring } from '../services/gacha-monitoring.ts';
import { reconcileStuckPrizes } from '../services/gacha-reconcile.ts'; // web3-free (DB + DAS) → eager-safe
import { recentRestocks } from '../services/gacha-stock.ts'; // web3-free (DB + CC read client) → eager-safe
import { resetGoldBalances } from '../services/gold.ts'; // web3-free (DB only) → eager-safe
import { getMachines, toLobbyMachine } from '../services/providers/collectorcrypt.ts';
import { setManualPrice, setPricePin } from '../services/admin-pricing.ts';
import { allocateFeesToInsurance, deallocateInsuranceToFees, getInsurance } from '../services/insurance.ts';
import { feeView, setFee, liqFeeView, setLiqFee, fundingFactorView, setFundingFactor, lpTradingPctView, setLpTradingPct, lpFundingPctView, setLpFundingPct, lpLiquidationPctView, setLpLiquidationPct } from '../services/fees.ts';
import { markClampView, setMarkClampBps } from '../services/marks.ts';
import { computePoolSnapshot, getPoolSnapshot, setPoolSnapshot } from '../services/pool-snapshot.ts';
import { listCustomers } from '../services/customers.ts';
import { marketStats } from '../services/admin-stats.ts';
import { houseEconomics } from '../services/house-pnl.ts';
import { restrictionsReport } from '../services/restrictions.ts';
import { markGuardsReport } from '../services/mark-guards.ts';
import { setMod, listModState, unmuteUser, setBanned, resolveChatUserId } from '../services/chat-mod.ts';
import { listChatUsers } from '../services/chat.ts';
import { chatConfigView, setChatThresholds } from '../services/chat-config.ts';
import { dropConfigView, setDropConfig, getDropView } from '../services/drop-config.ts';
import { totalTippedE6, recentTips } from '../services/drop.ts';
import { gamesAdminView, setPackRipConfig, setSetPokerConfig, setGradeGambleConfig, setTheBreakConfig, setPriceDuelConfig, setCardFantasyConfig, setDraftArenaConfig } from '../services/game-config.ts';
import { seedGamePool, packRipEv } from '../services/games.ts';
import { setPokerEv } from '../services/games-setpoker.ts';
import { gradeGambleEv } from '../services/games-grade.ts';
import { breakEv, cancelBreak } from '../services/games-break.ts';
import { cancelArena } from '../services/games-arena.ts';
import { getUserPositions, liquidateAllEligible } from '../services/engine.ts';
import { withdrawalAutoProcessView, setWithdrawalAutoProcess } from '../services/withdrawal-config.ts';
import { getCustomerHistory } from '../services/history.ts';
import { adminClosePosition, adminCloseUserPositions, adminCloseAllPositions } from '../services/admin-close.ts';
import { listAffiliates, setAffiliateTerms, maxCashbackBps, platformDefaultsView, setPlatformAffiliateDefaults } from '../services/affiliate.ts';

/**
 * Non-custody operator endpoints (ROADMAP §2). Unlike the custody admin routes, these register
 * whenever ADMIN_API_KEY is set — including play-money mode — because they don't move real funds.
 * Same auth as custody admin: the timing-safe ADMIN_API_KEY hook + the admin rate cap.
 *
 * Manual price override: the auto-oracle only covers pokemontcg.io (Pokémon, ~daily). Operators set
 * prices by hand from sources without an API (eBay sold listings, etc.); a set pins the market so the
 * auto-oracle won't overwrite it until unpinned.
 */
export async function adminOpsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireAdminKey);

  // Affiliate / KOL referral economics: list codes + their terms, and create/update a code's terms
  // (cashback% paid from house revenue + the affiliate's own fee-discount%, linked to a wallet). The
  // affiliate service validates bps bounds, the cashback ceiling, and the code; pre-provisions the wallet.
  app.get('/admin/affiliates', rl(config.routeRateLimits.admin), async () => ({
    affiliates: await listAffiliates(await getDb()),
    maxCashbackBps: maxCashbackBps(),
    platformDefaults: platformDefaultsView(), // the all-codes fallback rates (override per wallet below)
  }));
  app.post('/admin/affiliates', rl(config.routeRateLimits.admin), async (req) => {
    // setAffiliateTerms validates pubkey + the bps bounds itself, so pass the body straight through.
    const b = (req.body ?? {}) as {
      pubkey?: string; code?: string; cashbackBps: unknown; feeDiscountBps: unknown; label?: string; active?: boolean;
    };
    return setAffiliateTerms(await getDb(), { ...b, pubkey: b.pubkey ?? '' });
  });
  // Platform-wide default cashback + fee-discount applied to every referral code that has no active per-wallet
  // terms. setPlatformAffiliateDefaults validates both bps bounds (incl. the cashback ceiling).
  app.post('/admin/affiliate-defaults', rl(config.routeRateLimits.admin), async (req) => {
    const b = (req.body ?? {}) as { cashbackBps: unknown; feeDiscountBps: unknown };
    return setPlatformAffiliateDefaults(await getDb(), b);
  });

  // Set a manual price for a market (card or index). Pins by default.
  app.post('/admin/markets/:id/price', rl(config.routeRateLimits.admin), async (req) => {
    const { id } = req.params as { id: string };
    const input = SetPriceRequest.parse(req.body);
    const r = await setManualPrice(await getDb(), id, BigInt(input.priceE6), {
      pin: input.pin,
      force: input.force,
      note: input.note,
      operator: 'admin', // the key authenticates the operator; finer identity can come later
    });
    return { id, ...r };
  });

  // Unpin a market so the automated oracle resumes overwriting its price.
  app.post('/admin/markets/:id/unpin', rl(config.routeRateLimits.admin), async (req) => {
    const { id } = req.params as { id: string };
    await setPricePin(await getDb(), id, false);
    return { id, pinned: false };
  });

  // Insurance buffer (absorbs gap bad-debt before LPs). GET the balance; fund it from accumulated
  // platform fees (house money). (Funding from treasury surplus lives in the custody admin routes,
  // which can read the on-chain balance.) Both are ledger moves — no USDC leaves custody.
  app.get('/admin/insurance', rl(config.routeRateLimits.admin), async () => getInsurance(await getDb()));

  // House economics for the admin Overview — all ledger-derived, so it works in BOTH fund modes
  // (unlike /admin/treasury, which is real-funds-only and layers the chain/custody figures on top).
  app.get('/admin/economics', rl(config.routeRateLimits.admin), async () => houseEconomics(await getDb()));
  app.post('/admin/insurance/from-fees', rl(config.routeRateLimits.admin), async (req) => {
    const { amountUusdc } = InsuranceFundRequest.parse(req.body);
    return allocateFeesToInsurance(await getDb(), BigInt(amountUusdc));
  });
  app.post('/admin/insurance/to-fees', rl(config.routeRateLimits.admin), async (req) => {
    const { amountUusdc } = InsuranceFundRequest.parse(req.body);
    return deallocateInsuranceToFees(await getDb(), BigInt(amountUusdc));
  });

  // Live-tunable trading fee (bps of notional, charged on both open + close). GET -> { bps, default };
  // POST a bps value -> the new effective fee. The panel converts to/from a percentage for the operator.
  app.get('/admin/fee', rl(config.routeRateLimits.admin), async () => feeView());
  app.post('/admin/fee', rl(config.routeRateLimits.admin), async (req) => {
    const { bps } = FeeRequest.parse(req.body);
    await setFee(await getDb(), bps);
    return feeView();
  });

  // Live-tunable liquidation penalty (bps of a liquidated position's notional, routed to the insurance
  // fund). Same shape as /admin/fee.
  app.get('/admin/liq-fee', rl(config.routeRateLimits.admin), async () => liqFeeView());
  app.post('/admin/liq-fee', rl(config.routeRateLimits.admin), async (req) => {
    const { bps } = FeeRequest.parse(req.body);
    await setLiqFee(await getDb(), bps);
    return liqFeeView();
  });

  // Live-tunable funding factor — the MAX hourly funding rate (bps) at full skew. accrueFunding scales
  // it by the book's long/short skew each hour. GET -> { bps, default }; POST a bps value -> the new one.
  app.get('/admin/funding-factor', rl(config.routeRateLimits.admin), async () => fundingFactorView());
  app.post('/admin/funding-factor', rl(config.routeRateLimits.admin), async (req) => {
    const { bps } = FundingFactorRequest.parse(req.body);
    await setFundingFactor(await getDb(), bps);
    return fundingFactorView();
  });

  // Live-tunable mark-guard clamp (§6a) — the per-update cap (bps) on an UNCORROBORATED mark move under
  // ORACLE_PRIMARY=scrydex. A POST persists to settings, picked up within ~30s (no deploy). Same shape
  // as /admin/fee.
  app.get('/admin/mark-clamp', rl(config.routeRateLimits.admin), async () => markClampView());
  app.post('/admin/mark-clamp', rl(config.routeRateLimits.admin), async (req) => {
    const { bps } = MarkClampRequest.parse(req.body);
    await setMarkClampBps(await getDb(), bps);
    return markClampView();
  });

  // Live-tunable LP revenue shares — the % of each source routed to the LP pool (the house keeps the rest).
  // These drive the LIVE split mechanics immediately; the customer pool page shows a SEPARATELY-published
  // snapshot (see /admin/pool-snapshot below), so tuning here doesn't flicker the public page. GET ->
  // { pct, default }; POST a whole percent (0–100) -> the new one.
  app.get('/admin/lp-trading-pct', rl(config.routeRateLimits.admin), async () => lpTradingPctView());
  app.post('/admin/lp-trading-pct', rl(config.routeRateLimits.admin), async (req) => {
    const { pct } = LpSharePctRequest.parse(req.body);
    await setLpTradingPct(await getDb(), pct);
    return lpTradingPctView();
  });
  app.get('/admin/lp-funding-pct', rl(config.routeRateLimits.admin), async () => lpFundingPctView());
  app.post('/admin/lp-funding-pct', rl(config.routeRateLimits.admin), async (req) => {
    const { pct } = LpSharePctRequest.parse(req.body);
    await setLpFundingPct(await getDb(), pct);
    return lpFundingPctView();
  });
  app.get('/admin/lp-liquidation-pct', rl(config.routeRateLimits.admin), async () => lpLiquidationPctView());
  app.post('/admin/lp-liquidation-pct', rl(config.routeRateLimits.admin), async (req) => {
    const { pct } = LpSharePctRequest.parse(req.body);
    await setLpLiquidationPct(await getDb(), pct);
    return lpLiquidationPctView();
  });

  // Pool-page display snapshot. GET -> { published, live } (what the page currently shows vs what a refresh
  // would publish). POST refresh -> recompute + republish (the "Refresh pool numbers" button) so a fee-share
  // change (and the NAV-gain / APY figures) propagate to the customer page only when the operator decides.
  app.get('/admin/pool-snapshot', rl(config.routeRateLimits.admin), async () => {
    const db = await getDb();
    return { published: await getPoolSnapshot(db), live: await computePoolSnapshot(db) };
  });
  app.post('/admin/pool-snapshot/refresh', rl(config.routeRateLimits.admin), async () => setPoolSnapshot(await getDb()));

  // Live toggle: automatic withdrawal approval on/off. OFF => every withdrawal waits for manual approval.
  app.get('/admin/withdrawal-auto-process', rl(config.routeRateLimits.admin), async () => withdrawalAutoProcessView());
  app.post('/admin/withdrawal-auto-process', rl(config.routeRateLimits.admin), async (req) => {
    const { enabled } = WithdrawalAutoProcessRequest.parse(req.body);
    await setWithdrawalAutoProcess(await getDb(), enabled);
    return withdrawalAutoProcessView();
  });

  // Operator "Customers" view — one row per user (wallet, deposit address, balances, lifetime volume,
  // fees, funding, realized/unrealized P/L, deposits/withdrawals). Paginated + sortable; `sort` is
  // whitelisted inside listCustomers.
  app.get('/admin/customers', rl(config.routeRateLimits.admin), async (req) => {
    const q = req.query as { limit?: string; offset?: string; sort?: string };
    const limit = Math.min(200, Math.max(1, Math.floor(Number(q.limit)) || 50));
    const offset = Math.max(0, Math.floor(Number(q.offset)) || 0);
    return listCustomers(await getDb(), { limit, offset, sort: q.sort ?? 'volume' });
  });

  // One customer's open positions per market (the expand-row drill-down). Reuses the engine's view.
  app.get('/admin/customers/:id/positions', rl(config.routeRateLimits.admin), async (req) => {
    const { id } = req.params as { id: string };
    return { positions: await getUserPositions(await getDb(), id) };
  });

  // One customer's history (deposits, withdrawals, completed trades) for the expand-row History tab.
  app.get('/admin/customers/:id/history', rl(config.routeRateLimits.admin), async (req) => {
    const { id } = req.params as { id: string };
    return { entries: await getCustomerHistory(await getDb(), id, 200) };
  });

  // Operator close one of a customer's positions (recorded as a platform close via PLATFORM_ACTOR).
  app.post('/admin/customers/:id/positions/:positionId/close', rl(config.routeRateLimits.admin), async (req) => {
    const { id, positionId } = req.params as { id: string; positionId: string };
    return adminClosePosition(await getDb(), id, positionId);
  });

  // Operator close ALL of one customer's open positions (best-effort; per-position failures reported).
  app.post('/admin/customers/:id/positions/close-all', rl(config.routeRateLimits.admin), async (req) => {
    const { id } = req.params as { id: string };
    return adminCloseUserPositions(await getDb(), id);
  });

  // EMERGENCY kill switch: close EVERY open position across ALL customers. Gated by the admin key +
  // a destructive-confirm in the UI; best-effort, returns closed/failed counts.
  app.post('/admin/positions/close-all', rl(config.routeRateLimits.admin), async () => adminCloseAllPositions(await getDb()));

  // EMERGENCY: liquidate every UNDERWATER position now (the same sweep the background loop runs) instead
  // of waiting for it. Complements close-all, which can't touch liquidatable positions. Returns counts.
  app.post('/admin/positions/liquidate', rl(config.routeRateLimits.admin), async () => liquidateAllEligible(await getDb()));

  // Per-asset trading stats (volume 24h, locked margin, capped/raw net player P/L, long/short notional)
  // + the platform's total net payout exposure. Drives the main-view markets table + the exposure box.
  app.get('/admin/market-stats', rl(config.routeRateLimits.admin), async () => marketStats(await getDb()));

  // Price-confidence gate (oracle): which card markets are restricted (reduce-only) right now, and which
  // flipped INTO restricted today. Drives the admin "Restricted" badges + the daily transitions panel.
  app.get('/admin/restrictions', rl(config.routeRateLimits.admin), async () => restrictionsReport(await getDb()));

  // Mark guard (§6a): which card markets are clamped (mark creeping vs the candidate) right now, and the
  // engage/disengage transitions today. Drives the admin "mark guards" panel.
  app.get('/admin/mark-guards', rl(config.routeRateLimits.admin), async () => markGuardsReport(await getDb()));

  // --- CHAT admin view (docs/chat-social-spec.md). Three panels: action-bar thresholds, DROP config +
  // pot bucket, and moderation. All under the same admin-key hook; registers in both fund modes.

  // Panel 1 — live action-bar thresholds (whole USD). GET -> values + defaults; POST a partial -> the new
  // values. Reuses the chat-config live knobs (same settings-backed mechanism as the fee knobs).
  app.get('/admin/chat/thresholds', rl(config.routeRateLimits.admin), async () => chatConfigView());
  app.post('/admin/chat/thresholds', rl(config.routeRateLimits.admin), async (req) => {
    return setChatThresholds(await getDb(), ChatThresholdsRequest.parse(req.body));
  });

  // Panel 2 — DROP config (interval/house floor/pack tiers/GDEX min + the read-only eligibility mint) and
  // the pot bucket. Phase 1 persists the knobs + reads the DROP_POOL balance; the round worker is Phase 2.
  app.get('/admin/chat/drop-config', rl(config.routeRateLimits.admin), async () => dropConfigView());
  app.post('/admin/chat/drop-config', rl(config.routeRateLimits.admin), async (req) => {
    const b = DropConfigRequest.parse(req.body);
    return setDropConfig(await getDb(), b);
  });
  app.get('/admin/chat/drop', rl(config.routeRateLimits.admin), async () => {
    const db = await getDb();
    const [view, tipped, tips] = await Promise.all([getDropView(db), totalTippedE6(db), recentTips(db)]);
    return { ...view, totalTippedE6: tipped.toString(), recentTips: tips };
  });

  // Active chat users: everyone who has posted >=1 message, with their connected wallet + counts.
  app.get('/admin/chat/users', rl(config.routeRateLimits.admin), async () => ({ users: await listChatUsers(await getDb()) }));

  // Panel 3 — moderation. GET current mods/muted/banned + recent audit; POST an action on a user (the
  // path segment may be an internal id OR a wallet pubkey, resolved server-side). grant/revoke toggle MOD;
  // unmute/unban clear a mute/ban. In-chat mod actions live on /chat/* (mod-auth).
  app.get('/admin/chat/mods', rl(config.routeRateLimits.admin), async () => listModState(await getDb()));
  app.post('/admin/chat/mods/:userId', rl(config.routeRateLimits.admin), async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const { action } = ChatModActionRequest.parse(req.body);
    const db = await getDb();
    const id = await resolveChatUserId(db, userId);
    if (!id) return reply.code(404).send({ error: 'user not found' });
    switch (action) {
      case 'grant':
        return setMod(db, id, true, null); // null acting-mod = operator (admin key)
      case 'revoke':
        return setMod(db, id, false, null);
      case 'unmute':
        return unmuteUser(db, null, id);
      case 'unban':
        return setBanned(db, null, id, false);
      default:
        return reply.code(400).send({ error: 'unsupported action' }); // unreachable (Zod-validated) — defensive
    }
  });

  // --- GAMES admin view (docs/games-spec.md). Per-game config (live knobs) + the GAME_POOL bankroll.
  // Registers in both fund modes (no real funds move); seeding the pool is play-money only.

  // Current games config + defaults + the GAME_POOL balance + per-game EV/house-edge vs the live pool.
  app.get('/admin/games/config', rl(config.routeRateLimits.admin), async () => {
    const db = await getDb();
    return { ...(await gamesAdminView(db)), packRipEv: await packRipEv(db), setPokerEv: await setPokerEv(db), gradeGambleEv: await gradeGambleEv(db), breakEv: await breakEv(db) };
  });
  // Apply a partial games config patch (Pack Rip / Set Poker / Grade Gamble / The Break knobs).
  app.post('/admin/games/config', rl(config.routeRateLimits.admin), async (req) => {
    const b = GameConfigRequest.parse(req.body);
    const db = await getDb();
    if (b.packRip) await setPackRipConfig(db, b.packRip);
    if (b.setPoker) await setSetPokerConfig(db, b.setPoker);
    if (b.gradeGamble) await setGradeGambleConfig(db, b.gradeGamble);
    if (b.theBreak) await setTheBreakConfig(db, b.theBreak);
    if (b.priceDuel) await setPriceDuelConfig(db, b.priceDuel);
    if (b.cardFantasy) await setCardFantasyConfig(db, b.cardFantasy);
    if (b.draftArena) await setDraftArenaConfig(db, b.draftArena);
    return { ...(await gamesAdminView(db)), packRipEv: await packRipEv(db), setPokerEv: await setPokerEv(db), gradeGambleEv: await gradeGambleEv(db), breakEv: await breakEv(db) };
  });
  // Cancel + refund an open case (the safety valve for a break that won't fill).
  app.post('/admin/games/break/cancel', rl(config.routeRateLimits.admin), async (req) => cancelBreak(await getDb(), BreakCancelRequest.parse(req.body).roundId));
  // Cancel + refund an unfilled draft lobby (the worker also auto-cancels past the fill timeout).
  app.post('/admin/games/arena/cancel', rl(config.routeRateLimits.admin), async (req) => cancelArena(await getDb(), ArenaCancelRequest.parse(req.body).roundId));
  // Seed the GAME_POOL bankroll (play-money: from FAUCET_SOURCE) so prizes can be paid out.
  app.post('/admin/games/seed-pool', rl(config.routeRateLimits.admin), async (req) => {
    const { amountUsd } = GamePoolSeedRequest.parse(req.body);
    return seedGamePool(await getDb(), amountUsd);
  });

  // --- CLASSIC GACHA admin (docs/classic-gacha-cc-packs-spec.md §12). Live knobs (cut %s, markup, free-pack
  // threshold, per-machine enable) + the economics readout (cut revenue vs Token-rebate cost + sell-back rate).

  // Current knobs + the live CC machine list (each flagged enabled/disabled for the per-machine toggles).
  app.get('/admin/gacha/config', rl(config.routeRateLimits.admin), async () => {
    const cfg = gachaAdminConfig();
    const disabled = new Set(cfg.disabledMachines);
    // The full lobby machine (incl. live CC stock per tier, odds, $ ranges, EV, buyback) + the operator's
    // disabled flag, so the admin "Live machines" panel can surface stock/odds the player lobby doesn't.
    let machines: Array<ReturnType<typeof toLobbyMachine> & { disabled: boolean }> = [];
    try {
      const { machines: ccm } = await getMachines();
      machines = (ccm ?? []).map(toLobbyMachine).map((m) => ({ ...m, disabled: disabled.has(m.code) }));
    } catch { /* CC unreachable → still return the knobs (the machine toggles just won't list this load) */ }
    return { config: cfg, machines };
  });
  // Apply a partial gacha knob patch (each field validated by its own live knob).
  app.post('/admin/gacha/config', rl(config.routeRateLimits.admin), async (req) => {
    const b = req.body;
    if (typeof b !== 'object' || b === null || Array.isArray(b)) throw new HttpError(400, 'bad config body');
    return { config: await setGachaConfig(await getDb(), b as Record<string, unknown>) };
  });
  // Economics readout: cut revenue (+ markup) vs Token-rebate cost, net, and the live sell-back rate.
  app.get('/admin/gacha/monitoring', rl(config.routeRateLimits.admin), async () => {
    const db = await getDb();
    return { ...(await gachaMonitoring(db)), recentRestocks: await recentRestocks(db, { limit: 50 }), config: gachaAdminConfig() };
  });

  // Recover inventory rows stranded in 'selling'/'withdrawing' by a crash mid-flight (DAS owner is the oracle).
  app.post('/admin/gacha/reconcile-stuck', rl(config.routeRateLimits.admin), async (req) => {
    const graceSec = Number((req.body as { graceSec?: number } | undefined)?.graceSec);
    return reconcileStuckPrizes(await getDb(), Number.isFinite(graceSec) && graceSec >= 0 ? { graceSec } : {});
  });

  // Zero EVERY customer's loyalty Gold balance (destructive; writes an ADMIN_RESET ledger entry per user).
  app.post('/admin/gacha/reset-gold', rl(config.routeRateLimits.admin), async () => resetGoldBalances(await getDb()));
}
