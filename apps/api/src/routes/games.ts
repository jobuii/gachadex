import type { FastifyInstance } from 'fastify';
import { ClientSeedRequest, PackRipOpenRequest, PrizeSellRequest, SetPokerDealRequest, SetPokerSwapRequest, SetPokerSettleRequest } from '@pokex/shared-types';
import { config } from '../config.ts';
import { getDb } from '../db/client.ts';
import { authenticate } from '../plugins/auth.ts';
import { rl } from './_ratelimit.ts';
import { gamesView, getFairness, rotateClientSeed, openPack, sellBackPrize, listHeldPrizes } from '../services/games.ts';
import { dealHand, swapCard, settleHand, getOpenHand } from '../services/games-setpoker.ts';

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

  // Sell a held prize back for USDC at the live mark minus the buyback spread (any game's won card).
  app.post('/games/prizes/sell-back', rl(config.routeRateLimits.gamePlay, TRADE), async (req) => {
    const { prizeId } = PrizeSellRequest.parse(req.body);
    return sellBackPrize(await getDb(), req.userId!, prizeId);
  });
  // Back-compat alias for the Pack Rip panel.
  app.post('/games/pack-rip/sell-back', rl(config.routeRateLimits.gamePlay, TRADE), async (req) => {
    const { prizeId } = PrizeSellRequest.parse(req.body);
    return sellBackPrize(await getDb(), req.userId!, prizeId);
  });

  // The caller's still-held prizes (the "your pulls" list), valued at the live mark.
  app.get('/games/prizes', rl(config.routeRateLimits.gameFairness, TRADE), async (req) => ({ prizes: await listHeldPrizes(await getDb(), req.userId!) }));

  // Set Poker — deal a hand, swap a card, settle. The open hand can be resumed via GET.
  app.get('/games/set-poker/hand', rl(config.routeRateLimits.gameFairness, TRADE), async (req) => ({ hand: await getOpenHand(await getDb(), req.userId!) }));
  app.post('/games/set-poker/deal', rl(config.routeRateLimits.gamePlay, TRADE), async (req) => {
    const { idempotencyKey } = SetPokerDealRequest.parse(req.body);
    return dealHand(await getDb(), req.userId!, idempotencyKey);
  });
  app.post('/games/set-poker/swap', rl(config.routeRateLimits.gamePlay, TRADE), async (req) => {
    const { slot, idempotencyKey } = SetPokerSwapRequest.parse(req.body);
    return swapCard(await getDb(), req.userId!, slot, idempotencyKey);
  });
  app.post('/games/set-poker/settle', rl(config.routeRateLimits.gamePlay, TRADE), async (req) => {
    const { playId } = SetPokerSettleRequest.parse(req.body ?? {});
    return settleHand(await getDb(), req.userId!, playId);
  });
}
