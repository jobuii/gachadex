/**
 * Per-route rate-limit option shape for @fastify/rate-limit, merged into the route's options.
 * Caps live in config.ts (`routeRateLimits`) so every security-relevant limit is tunable + visible
 * together. Usage:
 *   app.post('/auth/nonce', rl(config.routeRateLimits.authNonce), handler)            // public
 *   app.post('/faucet', rl(config.routeRateLimits.faucet, { preHandler: authenticate }), handler)
 */
export const rl = (max: number, rest: object = {}) => ({
  ...rest,
  config: { ...(rest as { config?: object }).config, rateLimit: { max } },
});
