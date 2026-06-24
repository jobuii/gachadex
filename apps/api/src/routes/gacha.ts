import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import { HttpError } from '../errors.ts';
import { rl } from './_ratelimit.ts';
import { getMachines, getNfts, getAllWinners, toLobbyMachine, toLobbyCard, toLobbyWinner } from '../services/providers/collectorcrypt.ts';

/**
 * Classic Gacha lobby (docs/classic-gacha-cc-packs-spec.md, P0 — read-only). A public proxy of Collector
 * Crypt's gacha reads (machines / cards / winners), mapped to micro-USDC for the wire. Gated behind
 * CLASSIC_GACHA_ENABLED — 404 while off (the web also hides the entry via /health). No buying/custody here;
 * the open / sell-back / withdraw flows + money are P1+.
 */
const MACHINE_CODE_RE = /^[a-z0-9_-]{1,64}$/i; // CC codes look like "pokemon_50" — a cheap guard before we proxy to CC
const RARITIES = new Set(['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic']);

export async function gachaRoutes(app: FastifyInstance): Promise<void> {
  const gate = () => {
    if (!config.classicGachaEnabled) throw new HttpError(404, 'not found');
  };

  // Lobby tiles: the available CC machines (price, tier legend, buyback %, stock).
  app.get('/gacha/machines', rl(config.routeRateLimits.gameFairness), async () => {
    gate();
    const { machines } = await getMachines();
    return { machines: (machines ?? []).map(toLobbyMachine) };
  });

  // The real graded cards in a machine's pool.
  app.get('/gacha/machines/:code/cards', rl(config.routeRateLimits.gameFairness), async (req) => {
    gate();
    const { code } = req.params as { code: string };
    if (!MACHINE_CODE_RE.test(code)) throw new HttpError(400, 'bad machine code'); // don't forward arbitrary strings to CC
    const q = req.query as { rarity?: string; page?: string };
    const rarity = q.rarity && RARITIES.has(q.rarity.toLowerCase()) ? q.rarity.toLowerCase() : undefined;
    const page = q.page ? Math.min(Math.max(Number(q.page) || 1, 1), 50) : undefined;
    const { nfts } = await getNfts(code, { rarity, page });
    return { cards: (nfts ?? []).map(toLobbyCard) };
  });

  // Recent winners ticker (most-recent-first; count caps at 200).
  app.get('/gacha/winners', rl(config.routeRateLimits.gameFairness), async (req) => {
    gate();
    const q = req.query as { count?: string; packType?: string };
    const count = Math.min(Number(q.count) || 50, 200);
    const { data } = await getAllWinners({ count, packType: q.packType });
    return { winners: (data ?? []).map(toLobbyWinner) };
  });
}
