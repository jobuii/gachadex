import type { FastifyInstance } from 'fastify';
import { ClientSeedRequest, PackRipOpenRequest, PrizeSellRequest, SetPokerDealRequest, SetPokerSwapRequest, SetPokerSettleRequest, GradeOpenRequest, BreakJoinRequest, DuelJoinRequest, DuelCancelRequest } from '@pokex/shared-types';
import { config } from '../config.ts';
import { getDb } from '../db/client.ts';
import { authenticate } from '../plugins/auth.ts';
import { rl } from './_ratelimit.ts';
import { gamesView, getFairness, rotateClientSeed, openPack, sellBackPrize, listHeldPrizes } from '../services/games.ts';
import { dealHand, swapCard, settleHand, getOpenHand } from '../services/games-setpoker.ts';
import { gradeOpen } from '../services/games-grade.ts';
import { currentBreak, getBreakRound, joinBreak } from '../services/games-break.ts';
import { joinOrCreateDuel, myDuel, getDuel, cancelDuel } from '../services/games-duel.ts';

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

  // Grade Gamble — pay an ante, draw + grade a card (a held prize sold back at the graded value).
  app.post('/games/grade/open', rl(config.routeRateLimits.gamePlay, TRADE), async (req) => {
    const { tier, idempotencyKey } = GradeOpenRequest.parse(req.body);
    return gradeOpen(await getDb(), req.userId!, tier, idempotencyKey);
  });

  // The Break — the open case (+ your spots), a specific case to poll, and buy a spot.
  app.get('/games/break', rl(config.routeRateLimits.gameFairness, TRADE), async (req) => ({ round: await currentBreak(await getDb(), req.userId!) }));
  app.get('/games/break/:roundId', rl(config.routeRateLimits.gameFairness, TRADE), async (req) => ({ round: await getBreakRound(await getDb(), req.userId!, (req.params as { roundId: string }).roundId) }));
  app.post('/games/break/join', rl(config.routeRateLimits.gamePlay, TRADE), async (req) => {
    const { idempotencyKey } = BreakJoinRequest.parse(req.body);
    return joinBreak(await getDb(), req.userId!, idempotencyKey);
  });

  // Price Duel — your current duel, a specific duel to poll (settles on read), quick-match join, and cancel.
  app.get('/games/duel', rl(config.routeRateLimits.gameFairness, TRADE), async (req) => ({ duel: await myDuel(await getDb(), req.userId!) }));
  app.get('/games/duel/:duelId', rl(config.routeRateLimits.gameFairness, TRADE), async (req) => ({ duel: await getDuel(await getDb(), req.userId!, (req.params as { duelId: string }).duelId) }));
  app.post('/games/duel/join', rl(config.routeRateLimits.gamePlay, TRADE), async (req) => {
    const { marketId, idempotencyKey } = DuelJoinRequest.parse(req.body);
    return joinOrCreateDuel(await getDb(), req.userId!, marketId, idempotencyKey);
  });
  app.post('/games/duel/cancel', rl(config.routeRateLimits.gamePlay, TRADE), async (req) => {
    const { duelId } = DuelCancelRequest.parse(req.body);
    return cancelDuel(await getDb(), req.userId!, duelId);
  });
}
