import { AirwallexError } from "./errors.js";
import { RateLimiter } from "./limiter.js";
import type { AwxRequest, Transport } from "./types.js";

export interface HttpTransportOptions {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly apiKey: string;
  readonly fetch?: typeof fetch;
  readonly maxRetries?: number;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

/**
 * Real Airwallex REST transport.
 *  - Logs in with x-client-id / x-api-key, caches the 30-minute bearer token and refreshes early.
 *  - Paces requests below sandbox rate limits; backs off on 429.
 *  - Never retries a mutating call on an ambiguous failure by itself: callers decide, using
 *    request_id lookups, so a retry can never create a second transfer.
 */
export class HttpTransport implements Transport {
  readonly kind = "sandbox" as const;
  private token: { value: string; expiresAt: number } | null = null;
  private loginInFlight: Promise<string> | null = null;
  private readonly limiter = new RateLimiter();
  private readonly f: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: HttpTransportOptions) {
    this.f = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  private async bearer(): Promise<string> {
    if (this.token && this.token.expiresAt - 5 * 60_000 > this.now()) return this.token.value;
    this.loginInFlight ??= this.login().finally(() => {
      this.loginInFlight = null;
    });
    return this.loginInFlight;
  }

  private async login(): Promise<string> {
    const res = await this.f(`${this.opts.baseUrl}/api/v1/authentication/login`, {
      method: "POST",
      headers: { "x-client-id": this.opts.clientId, "x-api-key": this.opts.apiKey },
    });
    if (!res.ok) {
      throw new AirwallexError(
        res.status,
        "auth_failed",
        "Login failed; check client id, API key and scopes",
        "/authentication/login",
      );
    }
    const body = (await res.json()) as { token: string; expires_at?: string };
    const expiresAt = body.expires_at ? Date.parse(body.expires_at) : this.now() + 30 * 60_000;
    this.token = { value: body.token, expiresAt };
    return body.token;
  }

  async send<T>(req: AwxRequest): Promise<T> {
    const max = this.opts.maxRetries ?? 3;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.limiter.run(req.path, () => this.once<T>(req));
      } catch (e) {
        const err = e as AirwallexError;
        const safeToRetry =
          err instanceof AirwallexError && (err.status === 429 || (err.status === 401 && attempt === 0));
        if (err instanceof AirwallexError && err.status === 401) this.token = null;
        if (!safeToRetry || attempt >= max) throw e;
        await new Promise((r) => setTimeout(r, 250 * 2 ** attempt + Math.random() * 100));
      }
    }
  }

  private async once<T>(req: AwxRequest): Promise<T> {
    const token = await this.bearer();
    const qs = req.query ? `?${new URLSearchParams(req.query).toString()}` : "";
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    if (req.onBehalfOf) headers["x-on-behalf-of"] = req.onBehalfOf;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 20_000);
    let res: Response;
    try {
      res = await this.f(`${this.opts.baseUrl}/api/v1${req.path}${qs}`, {
        method: req.method,
        headers,
        body: req.method === "POST" ? JSON.stringify(req.body ?? {}) : undefined,
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new AirwallexError(0, "network_error", (e as Error).message, req.path);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    const json = text ? safeJson(text) : {};
    if (!res.ok) {
      const j = json as { code?: string; message?: string; source?: string };
      throw new AirwallexError(
        res.status,
        j.code ?? `http_${res.status}`,
        j.message ?? text.slice(0, 200),
        req.path,
        j.source,
      );
    }
    return json as T;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
