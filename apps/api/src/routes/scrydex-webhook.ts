import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import { getDb } from '../db/client.ts';
import { verifyScrydexSignature, type ScrydexWebhookEvent } from '../services/providers/scrydex.ts';
import { repriceExpansions } from '../services/oracle.ts';

/**
 * Scrydex price webhook (spec §8) — the PRIMARY update path under ORACLE_PRIMARY=scrydex. Scrydex POSTs
 * `{ id, name, data: { expansion_ids } }` whenever a card's raw price changes, HMAC-SHA256 signed
 * (Stripe-style `X-Scrydex-Signature: t=…,v1=…`). We verify against the RAW body, ack in <2s, and
 * re-price the affected expansions' tracked markets in the background (Scrydex times out at 10s and
 * retries 4×, so the receiver must be fast — the work must not block the response).
 *
 * The route is encapsulated so its raw-body content-type parser (needed for signature verification —
 * a re-stringified JSON would not match) doesn't affect the rest of the API, which keeps JSON parsing.
 */
const MAX_EXPANSION_IDS_PER_EVENT = 500; // a real event names a handful; bounds fan-out on a signed flood

export async function scrydexWebhookRoutes(app: FastifyInstance): Promise<void> {
  // Keep the raw JSON string (don't parse) so the signature is verified over the exact received bytes.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));

  app.post('/webhooks/scrydex', async (req, reply) => {
    // The encapsulated parser delivers application/json as the raw string; the '' fallback is defensive
    // (a non-string body fails verification — HMAC of an empty body still needs the secret).
    const raw = typeof req.body === 'string' ? req.body : '';
    const header = req.headers['x-scrydex-signature'];
    const sig = Array.isArray(header) ? header[0] : header;
    if (!verifyScrydexSignature(raw, sig, config.scrydexWebhookSecret)) {
      return reply.code(401).send({ error: 'invalid signature' });
    }

    let event: ScrydexWebhookEvent;
    try {
      event = JSON.parse(raw) as ScrydexWebhookEvent;
    } catch {
      return reply.code(400).send({ error: 'invalid payload' });
    }

    // Raw-price AND graded updates re-price (a reprice re-fetches the whole card, refreshing the raw mark
    // and the Scrydex graded ladder/PSA-10). Pop-report events are acked and ignored. Dedup + cap the
    // expansion list so one (validly-signed) event can't fan out to an unbounded batch fetch — a real
    // event names a handful of expansions; the daily credit cap is the backstop.
    const ids = [...new Set(event.data?.expansion_ids ?? [])].slice(0, MAX_EXPANSION_IDS_PER_EVENT);
    const reprices = typeof event.name === 'string' && (event.name.endsWith('prices.raw_updated') || event.name.endsWith('graded_updated'));
    if (reprices && ids.length > 0) {
      // Fire-and-forget: ack immediately (<2s), re-price in the background. A miss is caught by the
      // slow batch-poll reconcile, so a failed/aborted re-price is not lost forever.
      void getDb()
        .then((db) => repriceExpansions(db, ids))
        .catch((e) => app.log.error(e, `scrydex webhook reprice failed (event ${event.id ?? '?'})`));
    }
    return reply.code(200).send({ ok: true });
  });
}
