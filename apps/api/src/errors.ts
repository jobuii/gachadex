/**
 * A simple HTTP error carrying a status code; mapped to a reply by the error handler.
 * `code` is an optional STABLE machine-readable slug (e.g. 'insufficient_balance', 'scope_denied')
 * emitted alongside the human `error` prose — clients (the SDK/CLI) branch on the slug, never the
 * rewordable prose. Add new codes additively; never rename an existing one.
 */
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
