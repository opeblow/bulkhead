import { AirwallexError } from "./errors.js";
import type { AwxRequest, Transport } from "./types.js";

/** Paths that act on a customer's money and therefore MUST carry x-on-behalf-of in Bulkhead. */
const TENANT_SCOPED = [
  /^\/balances\/current$/,
  /^\/global_accounts(\/create)?$/,
  /^\/simulation\/deposit\/create$/,
  /^\/beneficiaries\/(create|validate)$/,
  /^\/fx\/(quotes|conversions)\/create$/,
  /^\/fx\/rates\/current$/,
  /^\/transfers(\/create)?$/,
  /^\/transfers\/[^/]+$/,
  /^\/simulation\/transfers\/[^/]+\/transition$/,
];

export function isTenantScoped(path: string): boolean {
  return TENANT_SCOPED.some((r) => r.test(path));
}

export interface CallRecord {
  readonly seq: number;
  readonly at: string;
  readonly method: string;
  readonly path: string;
  readonly onBehalfOf: string | null;
  readonly requestId: string | null;
  readonly tenantScoped: boolean;
  /** For tenant-scoped calls: header present. For platform calls: header absent. */
  readonly scopeOk: boolean;
  readonly ok: boolean;
  readonly status: number;
  readonly code?: string;
  readonly ms: number;
  readonly scope: "platform" | "tenant";
  readonly intent?: string;
}

/**
 * Wraps a transport and records every call. Gives the console an exact API trace and lets
 * us prove an invariant: every customer-scoped call carried the employer's x-on-behalf-of.
 */
export class RecordingTransport implements Transport {
  private seq = 0;
  private readonly log: CallRecord[] = [];
  private readonly listeners = new Set<(r: CallRecord) => void>();

  constructor(
    private readonly inner: Transport,
    private readonly opts: { platformScopedAllowlist?: RegExp[] } = {},
  ) {}

  get kind() {
    return this.inner.kind;
  }

  onRecord(fn: (r: CallRecord) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  calls(): readonly CallRecord[] {
    return this.log;
  }

  reset(): void {
    this.log.length = 0;
    this.seq = 0;
  }

  async send<T>(req: AwxRequest & { intent?: string; scope?: "platform" | "tenant" }): Promise<T> {
    const started = performance.now();
    const tenantScoped = isTenantScoped(req.path);
    const scope = req.scope ?? (req.onBehalfOf ? "tenant" : "platform");
    const allowPlatform =
      this.opts.platformScopedAllowlist?.some((r) => r.test(req.path)) && scope === "platform";
    const scopeOk = tenantScoped ? !!req.onBehalfOf || !!allowPlatform : !req.onBehalfOf;
    const body = req.body as Record<string, unknown> | undefined;
    const base = {
      at: new Date().toISOString(),
      method: req.method,
      path: req.path,
      onBehalfOf: req.onBehalfOf ?? null,
      requestId: typeof body?.request_id === "string" ? body.request_id : null,
      tenantScoped,
      scopeOk,
      scope,
      intent: req.intent,
    };
    try {
      const { intent: _i, scope: _s, ...wire } = req;
      const res = await this.inner.send<T>(wire);
      this.push({ ...base, ok: true, status: 200, ms: performance.now() - started });
      return res;
    } catch (e) {
      const err = e as AirwallexError;
      this.push({
        ...base,
        ok: false,
        status: err instanceof AirwallexError ? err.status : 0,
        code: err instanceof AirwallexError ? err.code : "client_error",
        ms: performance.now() - started,
      });
      throw e;
    }
  }

  private push(r: Omit<CallRecord, "seq">): void {
    const rec = { ...r, seq: ++this.seq, ms: Math.round(r.ms * 10) / 10 };
    this.log.push(rec);
    for (const l of this.listeners) l(rec);
  }
}
