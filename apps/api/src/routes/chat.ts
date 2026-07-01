import type { FastifyInstance } from 'fastify';
import { ChatPostRequest, UsernameRequest, AvatarRequest, ColorRequest, ChatMuteRequest, ReactRequest, ChatTipRequest } from '@pokex/shared-types';
import { config } from '../config.ts';
import { usdc } from '../money.ts';
import { getDb } from '../db/client.ts';
import { authenticate, requireMod, optionalViewerId } from '../plugins/auth.ts';
import { rl } from './_ratelimit.ts';
import { listChat, postChat, getProfile, setUsername, setAvatar, setColor, getProfileCard } from '../services/chat.ts';
import { deleteMessage, muteUser, unmuteUser, setBanned } from '../services/chat-mod.ts';
import { toggleReaction } from '../services/chat-reactions.ts';
import { tipDrop } from '../services/drop.ts';
import { rankMap } from '../services/leaderboard.ts';

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  // public read; optionally authenticated so a signed-in viewer's own reactions come back highlighted.
  app.get('/chat', async (req) => ({ messages: await listChat(await getDb(), { viewerUserId: await optionalViewerId(req) }) }));

  // top-100 userId -> rank for chat rank badges (cached ~60s). Public, like the leaderboard itself.
  app.get('/chat/ranks', async () => rankMap(await getDb()));

  // public profile card for the hover popover: identity + rank + level.
  app.get('/chat/profile/:userId', async (req) => {
    const { userId } = req.params as { userId: string };
    return getProfileCard(await getDb(), userId);
  });

  // public DROP tip settings: whether tipping is open + the bounds (drives the tip input). The pot amount
  // itself is deliberately NOT exposed to customers — only the admin sees it.
  app.get('/chat/drop/pot', async () => ({
    tipsEnabled: config.dropTipsEnabled,
    minUsd: config.dropTipMinUsd,
    maxUsd: config.dropTipMaxUsd,
  }));

  // tip real USDC into the DROP pot (authed; full scope — it moves collateral). Gated by DROP_TIPS_ENABLED.
  app.post('/chat/drop/tip', rl(config.routeRateLimits.chatPost, { preHandler: authenticate, config: { scope: 'full' } }), async (req) => {
    const { amountUsd } = ChatTipRequest.parse(req.body ?? {});
    return tipDrop(await getDb(), req.userId!, usdc(amountUsd));
  });

  app.post('/chat', rl(config.routeRateLimits.chatPost, { preHandler: authenticate, config: { scope: 'full' } }), async (req) => {
    const { body, replyTo } = ChatPostRequest.parse(req.body ?? {});
    return postChat(await getDb(), req.userId!, body, replyTo);
  });

  app.get('/me/profile', { preHandler: authenticate, config: { scope: 'trade' } }, async (req) => {
    return getProfile(await getDb(), req.userId!);
  });

  app.post('/me/username', rl(config.routeRateLimits.username, { preHandler: authenticate, config: { scope: 'full' } }), async (req) => {
    const { username } = UsernameRequest.parse(req.body ?? {});
    return setUsername(await getDb(), req.userId!, username);
  });

  app.post('/me/avatar', rl(config.routeRateLimits.username, { preHandler: authenticate, config: { scope: 'full' } }), async (req) => {
    const { avatar } = AvatarRequest.parse(req.body ?? {});
    return setAvatar(await getDb(), req.userId!, avatar);
  });

  app.post('/me/color', rl(config.routeRateLimits.username, { preHandler: authenticate, config: { scope: 'full' } }), async (req) => {
    const { color } = ColorRequest.parse(req.body ?? {});
    return setColor(await getDb(), req.userId!, color);
  });

  // toggle an emoji reaction on a message (add if absent, remove if present)
  app.post('/chat/messages/:id/react', rl(config.routeRateLimits.chatPost, { preHandler: authenticate, config: { scope: 'full' } }), async (req) => {
    const { id } = req.params as { id: string };
    const { emoji } = ReactRequest.parse(req.body ?? {});
    return toggleReaction(await getDb(), req.userId!, id, emoji);
  });

  // --- moderator actions (in-chat; require a moderator account). Operator equivalents are admin-key routes.
  const modRoute = rl(config.routeRateLimits.chatPost, { preHandler: [authenticate, requireMod], config: { scope: 'full' as const } });

  app.post('/chat/messages/:id/delete', modRoute, async (req) => {
    const { id } = req.params as { id: string };
    return deleteMessage(await getDb(), req.userId!, id);
  });

  app.post('/chat/users/:id/mute', modRoute, async (req) => {
    const { id } = req.params as { id: string };
    const { minutes } = ChatMuteRequest.parse(req.body ?? {});
    return muteUser(await getDb(), req.userId!, id, minutes);
  });

  app.post('/chat/users/:id/unmute', modRoute, async (req) => {
    const { id } = req.params as { id: string };
    return unmuteUser(await getDb(), req.userId!, id);
  });

  app.post('/chat/users/:id/ban', modRoute, async (req) => {
    const { id } = req.params as { id: string };
    return setBanned(await getDb(), req.userId!, id, true);
  });

  app.post('/chat/users/:id/unban', modRoute, async (req) => {
    const { id } = req.params as { id: string };
    return setBanned(await getDb(), req.userId!, id, false);
  });
}
