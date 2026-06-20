import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import { rl } from './_ratelimit.ts';

// CDNs we re-serve from our own origin so the PnL share-card <canvas> can export to PNG. Those hosts send
// no `Access-Control-Allow-Origin`, so a canvas drawing their image directly would be tainted and
// toBlob()/toDataURL() would throw. Re-serving through our API (which DOES set CORS) makes the image
// canvas-clean. Whitelisted + https-only + image-only so this can't be used as an open SSRF proxy.
const ALLOWED_HOSTS = new Set([
  'cdn.tcgpricelookup.com',
  'images.pokemontcg.io',
  'images.scrydex.com',
  'assets.scrydex.com',
]);

export async function imageProxyRoutes(app: FastifyInstance): Promise<void> {
  app.get('/image-proxy', rl(config.routeRateLimits.imageProxy), async (req, reply) => {
    const raw = (req.query as { url?: string }).url;
    if (!raw) return reply.code(400).send({ error: 'url required' });
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return reply.code(400).send({ error: 'invalid url' });
    }
    if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) {
      return reply.code(403).send({ error: 'host not allowed' });
    }
    const upstream = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) }).catch(() => null);
    if (!upstream || !upstream.ok) return reply.code(502).send({ error: 'upstream fetch failed' });
    const contentType = upstream.headers.get('content-type') ?? '';
    if (!contentType.startsWith('image/')) return reply.code(415).send({ error: 'not an image' });
    // cap the body so a (whitelisted) host can't pull an unbounded blob into memory; card art is small
    if (Number(upstream.headers.get('content-length') ?? 0) > 5_000_000) return reply.code(413).send({ error: 'image too large' });
    const body = Buffer.from(await upstream.arrayBuffer());
    return reply
      .header('content-type', contentType)
      .header('cache-control', 'public, max-age=86400, immutable')
      .send(body);
  });
}
