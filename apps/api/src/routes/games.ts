import type { FastifyInstance } from 'fastify';
import { ClientSeedRequest, PackRipOpenRequest, PrizeSellRequest } from '@pokex/shared-types';
import { config } from '../config.ts';
import { getDb } from '../db/client.ts';
import { authenticate } from '../plugins/auth.ts';
import { rl } from './_ratelimit.ts';
import { gamesView, getFairness, rotateClientSeed, openPack, sellBackPrize, listHeldPrizes } from '../services/games.ts';

const TRADE = { preHandler: authenticate, config: { scope: 'trade' as const } };

/**
 * Games surface (docs/games-spec.md). Public lobby config + the authed provably-fair panel + Pack Rip
 * play/settle. Authed routes are trade-scoped + rate-limited; the play routes also gate on the master
 * GAMES_ENABLED flag and the per-game `enabled` knob inside the service.
 */
export async function gameRoutes(app: FastifyInstance): Promise<void> {
  // Public lobby: the games list + per-game config (drives the tiles + tier picker).
  app.get('/games', async () => gamesView());

  // Provably-fair panel: current commit hash / client seed / nonce.
  app.get('/games/fairness', rl(config.routeRateLimits.gameFairness, TRADE), async (req) => getFairness(await getDb(), req.userId!));

  // Rotate the client seed — reveals the prior server seed so past plays can be verified.
  app.post('/games/fairness/client-seed', rl(config.routeRateLimits.gameFairness, TRADE), async (req) => {
    const { clientSeed } = ClientSeedRequest.parse(req.body);
    return rotateClientSeed(await getDb(), req.userId!, clientSeed);
  });

  // Pack Rip — open a pack (debit + provably-fair reveal + award held card).
  app.post('/games/pack-rip/open', rl(config.routeRateLimits.gamePlay, TRADE), async (req) => {
    const body = PackRipOpenRequest.parse(req.body);
    return openPack(await getDb(), req.userId!, { tier: body.tier, idempotencyKey: body.idempotencyKey });
  });

  // Sell a held prize back for USDC at the live mark minus the buyback spread.
  app.post('/games/pack-rip/sell-back', rl(config.routeRateLimits.gamePlay, TRADE), async (req) => {
    const { prizeId } = PrizeSellRequest.parse(req.body);
    return sellBackPrize(await getDb(), req.userId!, prizeId);
  });

  // The caller's still-held prizes (the "your pulls" list), valued at the live mark.
  app.get('/games/prizes', rl(config.routeRateLimits.gameFairness, TRADE), async (req) => ({ prizes: await listHeldPrizes(await getDb(), req.userId!) }));
}
