import type { FastifyInstance } from 'fastify';
import { GAMES } from '@pokex/shared-types';
import { getDb } from '../db/client.ts';
import { listMarketsWithData, getCandles, getMarketDetails } from '../services/markets.ts';
import { searchCatalog, ensureMarketFromCard } from '../services/providers/search.ts';
import { getDefaultClient } from '../services/providers/tcgpricelookup.ts';
import { authenticate } from '../plugins/auth.ts';
import { config, catalogSearchEnabled, searchAndBetActive } from '../config.ts';
import { rl } from './_ratelimit.ts';
import { HttpError } from '../errors.ts';

const TF_DAYS: Record<string, number> = { '1D': 1, '1W': 7, '1M': 30, '3M': 90, '1Y': 365 };

export async function marketRoutes(app: FastifyInstance): Promise<void> {
  app.get('/markets', async () => ({ markets: await listMarketsWithData(await getDb()) }));

  app.get('/markets/:id/candles', async (req) => {
    const { id } = req.params as { id: string };
    const tf = (req.query as { tf?: string })?.tf ?? '1M';
    const days = TF_DAYS[tf] ?? 30;
    return { tf, candles: await getCandles(await getDb(), id, days) };
  });

  app.get('/markets/:id/details', async (req) => {
    const { id } = req.params as { id: string };
    const details = await getMarketDetails(await getDb(), id);
    if (!details) throw new HttpError(404, 'market not found');
    return details;
  });

  // Catalogue search (read-only) is live once the feature flag is on + tcgpricelookup drives the
  // oracle — it does NOT depend on the NAV gates (it browses, it doesn't create a market).
  if (!catalogSearchEnabled) return;

  // Whole-catalog search (cached 1h per (q, game); uncached calls cost a provider request — capped
  // per IP on top of the global limiter). Authenticated: the catalogue is a provider-billed lookup,
  // not public browsing, so anonymous traffic can't drain the provider budget (trade scope = a
  // delegated trading key may search too, mirroring /markets/ensure).
  app.get('/catalog/search', rl(config.routeRateLimits.catalogSearch, { preHandler: authenticate, config: { scope: 'trade' as const } }), async (req) => {
    const { q, game } = (req.query ?? {}) as { q?: string; game?: string };
    const query = (q ?? '').trim();
    if (query.length < 2 || query.length > 80) throw new HttpError(400, 'query must be 2-80 characters', 'bad_query');
    if (!game || !(GAMES as readonly string[]).includes(game)) throw new HttpError(400, 'unknown game', 'bad_game');
    const db = await getDb();
    return { results: await searchCatalog(db, getDefaultClient(db), query, game) };
  });

  // On-demand market creation CREATES a real-money-tradeable market; it follows catalogue search
  // (searchAndBetActive === catalogSearchEnabled). The old real-funds NAV-gate requirement was removed
  // 2026-06-22, so listing is on wherever catalogue search is on.
  if (!searchAndBetActive) return;

  // Authenticated (trade scope: delegated trading keys may list too) so anonymous traffic can't mint
  // markets; idempotent — an existing market is returned, not duplicated.
  app.post(
    '/markets/ensure',
    rl(config.routeRateLimits.marketEnsure, { preHandler: authenticate, config: { scope: 'trade' as const } }),
    async (req) => {
      const { providerCardId } = (req.body ?? {}) as { providerCardId?: string };
      if (typeof providerCardId !== 'string' || !/^[0-9a-f-]{8,64}$/i.test(providerCardId)) {
        throw new HttpError(400, 'providerCardId required', 'bad_card_id');
      }
      const db = await getDb();
      return ensureMarketFromCard(db, getDefaultClient(db), providerCardId);
    },
  );
}
