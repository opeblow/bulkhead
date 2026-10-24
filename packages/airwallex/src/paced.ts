import { AirwallexError } from "./errors.js";
import { RateLimiter } from "./limiter.js";
import type { AwxRequest, Transport } from "./types.js";

/**
 * Client-side pacing plus 429 backoff for any transport. A 429 means the request was not
 * processed, so retrying it (with the same request_id) is always safe.
 */
export class PacedTransport implements Transport {
  private readonly limiter: RateLimiter;

  constructor(
    private readonly inner: Transport,
    opts: { globalRps?: number; perPathRps?: number; concurrency?: number; maxRetries?: number } = {},
  ) {
    this.limiter = new RateLimiter({
      globalRps: opts.globalRps ?? 15,
      perPathRps: opts.perPathRps ?? 8,
      concurrency: opts.concurrency ?? 6,
    });
    this.maxRetries = opts.maxRetries ?? 5;
  }

  private readonly maxRetries: number;

  get kind() {
    return this.inner.kind;
  }

  async send<T>(req: AwxRequest): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.limiter.run(req.path, () => this.inner.send<T>(req));
      } catch (e) {
        if (e instanceof AirwallexError && e.status === 429 && attempt < this.maxRetries) {
          await new Promise((r) => setTimeout(r, 200 * 2 ** attempt + Math.random() * 100));
          continue;
        }
        throw e;
      }
    }
  }
}
