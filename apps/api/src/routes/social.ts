import type { FastifyInstance } from 'fastify';
import { ReferralRedeemRequest, ReferralCodeRequest } from '@pokex/shared-types';
import { config } from '../config.ts';
import { getDb } from '../db/client.ts';
import { authenticate } from '../plugins/auth.ts';
import { rl } from './_ratelimit.ts';
import { verifyAccessToken } from '../services/auth.ts';
import { getLeaderboard } from '../services/leaderboard.ts';
import { getReferralInfo, redeemReferral, setReferralCode } from '../services/referral.ts';

export async function socialRoutes(app: FastifyInstance): Promise<void> {
  // Public board; a Bearer token is OPTIONAL and only used to pin the caller's own row.
  app.get('/leaderboard', async (req) => {
    const db = await getDb();
    const limit = Number((req.query as { limit?: string } | undefined)?.limit) || 100;
    const header = req.headers['authorization'];
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    let viewerUserId: string | undefined;
    if (token) {
      try {
        viewerUserId = (await verifyAccessToken(token)).userId;
      } catch {
        /* anonymous view */
      }
    }
    return getLeaderboard(db, { limit, viewerUserId });
  });

  app.get('/referral/me', { preHandler: authenticate, config: { scope: 'trade' } }, async (req) => {
    return getReferralInfo(await getDb(), req.userId!);
  });

  app.post('/referral/redeem', rl(config.routeRateLimits.referralRedeem, { preHandler: authenticate, config: { scope: 'full' } }), async (req) => {
    const { code } = ReferralRedeemRequest.parse(req.body ?? {});
    return redeemReferral(await getDb(), req.userId!, code);
  });

  app.post('/referral/code', rl(config.routeRateLimits.referralCode, { preHandler: authenticate, config: { scope: 'full' } }), async (req) => {
    const { code } = ReferralCodeRequest.parse(req.body ?? {});
    return setReferralCode(await getDb(), req.userId!, code);
  });
}
