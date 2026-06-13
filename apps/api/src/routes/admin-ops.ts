import type { FastifyInstance } from 'fastify';
import { SetPriceRequest, InsuranceFundRequest, FeeRequest, FundingFactorRequest } from '@pokex/shared-types';
import { config } from '../config.ts';
import { getDb } from '../db/client.ts';
import { rl } from './_ratelimit.ts';
import { requireAdminKey } from './admin.ts';
import { setManualPrice, setPricePin } from '../services/admin-pricing.ts';
import { allocateFeesToInsurance, deallocateInsuranceToFees, getInsurance } from '../services/insurance.ts';
import { feeView, setFee, liqFeeView, setLiqFee, fundingFactorView, setFundingFactor } from '../services/fees.ts';
import { listCustomers } from '../services/customers.ts';
import { marketStats } from '../services/admin-stats.ts';
import { getUserPositions } from '../services/engine.ts';

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

  // Per-asset trading stats (volume 24h, locked margin, capped/raw net player P/L, long/short notional)
  // + the platform's total net payout exposure. Drives the main-view markets table + the exposure box.
  app.get('/admin/market-stats', rl(config.routeRateLimits.admin), async () => marketStats(await getDb()));
}
