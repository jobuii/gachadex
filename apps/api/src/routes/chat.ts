import type { FastifyInstance } from 'fastify';
import { ChatPostRequest, UsernameRequest, ChatMuteRequest, ReactRequest } from '@pokex/shared-types';
import { config } from '../config.ts';
import { getDb } from '../db/client.ts';
import { authenticate, requireMod, optionalViewerId } from '../plugins/auth.ts';
import { rl } from './_ratelimit.ts';
import { listChat, postChat, getProfile, setUsername, getProfileCard } from '../services/chat.ts';
import { deleteMessage, muteUser, unmuteUser, setBanned } from '../services/chat-mod.ts';
import { toggleReaction } from '../services/chat-reactions.ts';
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
