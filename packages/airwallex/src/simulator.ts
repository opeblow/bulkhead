import { createHash, randomUUID } from "node:crypto";
import {
  type Currency,
  convert,
  isCurrency,
  parseMoney,
  parseRate,
  sellNeededFor,
  toMajor,
} from "@bulkhead/core";
import { validAba, validIban, validSortCode, validSwift } from "./bank-validation.js";
import { AirwallexError } from "./errors.js";
import type {
  AwxAccount,
  AwxBalance,
  AwxBeneficiary,
  AwxBeneficiaryPayload,
  AwxCharge,
  AwxConnectedAccountTransfer,
  AwxConversion,
  AwxDeposit,
  AwxEvent,
  AwxGlobalAccount,
  AwxList,
  AwxQuote,
  AwxRequest,
  AwxTransfer,
  Transport,
} from "./types.js";

export const PLATFORM_ACCOUNT = "acct_platform_bulkhead";

export interface SimulatorOptions {
  /** Mid-market base rates: units of quote currency per 1 USD. */
  readonly baseRates?: Partial<Record<Currency, string>>;
  /** Spread applied to client rates, in basis points. */
  readonly spreadBps?: number;
  /** How long after activation FX returns unconfigured_client_fee. Sandbox: "a few minutes". */
  readonly feeConfigDelayMs?: number;
  readonly quoteTtlMs?: number;
  /** Charges / platform transfers report NEW for this many reads before SETTLED. */
  readonly settleAfterReads?: number;
  readonly swiftFees?: Partial<Record<Currency, string>>;
  readonly platformFunding?: Partial<Record<Currency, string>>;
  readonly now?: () => number;
  /** Per-endpoint per-second limit; exceeded calls get 429. */
  readonly perEndpointRps?: number;
  /** Deterministic rate drift per minute in bps (for demoing quote drift). */
  readonly driftBpsPerMinute?: number;
}

interface Account {
  record: AwxAccount;
  activatedAt?: number;
  balances: Map<Currency, bigint>;
}

const DEFAULT_RATES: Partial<Record<Currency, string>> = {
  USD: "1",
  EUR: "0.9214",
  GBP: "0.7931",
  AUD: "1.5122",
  SGD: "1.3015",
  CAD: "1.3770",
  HKD: "7.7710",
  JPY: "151.42",
};

/**
 * In-memory Airwallex sandbox. Behaves like the real sandbox where it matters for Track 6:
 *  - A call without x-on-behalf-of acts on the PLATFORM wallet (the classic kit-6 footgun).
 *  - FX is forbidden before ACTIVE and returns unconfigured_client_fee shortly after activation.
 *  - Deposits answer PENDING but credit the balance immediately.
 *  - SWIFT fees debit the same wallet as the payout; LOCAL is free.
 *  - On-behalf transfers stay PROCESSING until simulated; failures end in CANCELLED + failure_type.
 *  - Three different insufficient-funds codes depending on the endpoint.
 *  - request_id reuse returns duplicate_request_id; transfers require 10–50 chars (code 018).
 *  - Charges and connected-account transfers return NEW and settle later.
 */
export class SimulatedAirwallex implements Transport {
  readonly kind = "simulator" as const;
  private readonly accounts = new Map<string, Account>();
  private readonly globalAccounts = new Map<string, AwxGlobalAccount & { owner: string }>();
  private readonly beneficiaries = new Map<string, AwxBeneficiary & { owner: string }>();
  private readonly quotes = new Map<string, AwxQuote & { owner: string; expiresAt: number }>();
  private readonly conversions = new Map<string, AwxConversion & { owner: string }>();
  private readonly transfers = new Map<string, AwxTransfer & { owner: string }>();
  private readonly charges = new Map<string, AwxCharge & { reads: number }>();
  private readonly catransfers = new Map<string, AwxConnectedAccountTransfer & { reads: number }>();
  private readonly requestIds = new Map<string, string>();
  private readonly hits = new Map<string, number[]>();
  private readonly listeners = new Set<(e: AwxEvent) => void>();
  private readonly startedAt: number;
  readonly opts: Required<SimulatorOptions>;

  constructor(options: SimulatorOptions = {}) {
    this.opts = {
      baseRates: { ...DEFAULT_RATES, ...options.baseRates },
      spreadBps: options.spreadBps ?? 30,
      feeConfigDelayMs: options.feeConfigDelayMs ?? 0,
      quoteTtlMs: options.quoteTtlMs ?? 60_000,
      settleAfterReads: options.settleAfterReads ?? 1,
      swiftFees: { EUR: "12.85", GBP: "10.95", USD: "15.00", ...options.swiftFees },
      platformFunding: options.platformFunding ?? { USD: "5000" },
      now: options.now ?? Date.now,
      perEndpointRps: options.perEndpointRps ?? 10,
      driftBpsPerMinute: options.driftBpsPerMinute ?? 0,
    };
    this.startedAt = this.opts.now();
    const platform: Account = {
      record: {
        id: PLATFORM_ACCOUNT,
        status: "ACTIVE",
        account_details: { business_details: { business_name: "Bulkhead Platform (sandbox)" } },
        created_at: this.iso(),
      },
      activatedAt: this.startedAt - 3_600_000,
      balances: new Map(),
    };
    for (const [ccy, amt] of Object.entries(this.opts.platformFunding)) {
      if (isCurrency(ccy) && amt) platform.balances.set(ccy, parseMoney(amt, ccy).minor);
    }
    this.accounts.set(PLATFORM_ACCOUNT, platform);
  }

  onEvent(fn: (e: AwxEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Test/demo helper: read balances without going through the API. */
  peekBalance(accountId: string, ccy: Currency): string {
    const acct = this.accounts.get(accountId);
    return toMajor({ currency: ccy, minor: acct?.balances.get(ccy) ?? 0n });
  }

  // ───────────────────────────────── transport ─────────────────────────────────

  async send<T>(req: AwxRequest): Promise<T> {
    this.throttle(req.path);
    const actor = req.onBehalfOf ?? PLATFORM_ACCOUNT;
    if (req.onBehalfOf && !this.accounts.has(req.onBehalfOf)) {
      throw new AirwallexError(
        404,
        "account_not_found",
        `Unknown connected account ${req.onBehalfOf}`,
        req.path,
      );
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const p = req.path;
    const route = `${req.method} ${p}`;
    /** Path parameter for `re` when the method matches, else null. */
    const param = (re: RegExp, method: AwxRequest["method"]): string | null =>
      req.method === method ? (p.match(re)?.[1] ?? null) : null;
    const out = await (async (): Promise<unknown> => {
      const accountUpdate = param(/^\/accounts\/([^/]+)\/update$/, "POST");
      const accountSubmit = param(/^\/accounts\/([^/]+)\/submit$/, "POST");
      const accountActivate = param(/^\/simulation\/accounts\/([^/]+)\/update_status$/, "POST");
      const accountGet = param(/^\/accounts\/([^/]+)$/, "GET");
      const transferGet = param(/^\/transfers\/([^/]+)$/, "GET");
      const transferSim = param(/^\/simulation\/transfers\/([^/]+)\/transition$/, "POST");
      const chargeGet = param(/^\/charges\/([^/]+)$/, "GET");
      const catGet = param(/^\/connected_account_transfers\/([^/]+)$/, "GET");
      if (route === "POST /accounts/create") return this.createAccount(body);
      if (accountUpdate) return this.updateAccount(accountUpdate, body);
      if (accountSubmit) return this.submitAccount(accountSubmit);
      if (accountActivate) return this.activateAccount(accountActivate, body);
      if (accountGet) return this.getAccount(accountGet);
      if (route === "GET /global_accounts") return this.listGlobalAccounts(actor);
      if (route === "POST /global_accounts/create") return this.createGlobalAccount(actor, body);
      if (route === "POST /simulation/deposit/create") return this.simulateDeposit(req, body);
      if (route === "GET /balances/current") return this.balances(actor);
      if (route === "POST /beneficiaries/validate")
        return this.validateBeneficiary(body as unknown as AwxBeneficiaryPayload);
      if (route === "POST /beneficiaries/create") return this.createBeneficiary(actor, body);
      if (route === "GET /fx/rates/current") return this.rate(actor, req.query ?? {});
      if (route === "POST /fx/quotes/create") return this.createQuote(actor, body);
      if (route === "POST /fx/conversions/create") return this.createConversion(actor, body);
      if (route === "POST /transfers/create") return this.createTransfer(req, actor, body);
      if (route === "GET /transfers") return this.listTransfers(actor, req.query ?? {});
      if (transferGet) return this.getTransfer(actor, transferGet);
      if (transferSim) return this.transitionTransfer(req, actor, transferSim, body);
      if (route === "POST /charges/create") return this.createCharge(body);
      if (chargeGet) return this.readMovement(this.charges, chargeGet, p);
      if (route === "POST /connected_account_transfers/create") return this.createCaTransfer(body);
      if (catGet) return this.readMovement(this.catransfers, catGet, p);
      throw new AirwallexError(404, "not_found", `Simulator has no route for ${route}`, p);
    })();
    return structuredClone(out) as T;
  }

  // ───────────────────────────────── helpers ─────────────────────────────────

  private iso(): string {
    return new Date(this.opts.now()).toISOString();
  }

  private throttle(path: string): void {
    const key = path.replace(/\/(acct|tfr|ben|chg|cat|q|conv|ga)_[A-Za-z0-9-]+/g, "/:id");
    const t = this.opts.now();
    const arr = (this.hits.get(key) ?? []).filter((x) => t - x < 1000);
    if (arr.length >= this.opts.perEndpointRps) {
      throw new AirwallexError(429, "too_many_requests", "Rate limit exceeded", path);
    }
    arr.push(t);
    this.hits.set(key, arr);
  }

  private claimRequestId(scope: string, requestId: unknown, path: string, minLen = 1): string {
    if (typeof requestId !== "string" || !requestId)
      throw new AirwallexError(400, "001", "request_id is required", path, "request_id");
    if (requestId.length < minLen || requestId.length > 50) {
      throw new AirwallexError(
        400,
        "018",
        "request_id must be between 10 and 50 characters",
        path,
        "request_id",
      );
    }
    const key = `${scope}:${requestId}`;
    if (this.requestIds.has(key)) {
      throw new AirwallexError(
        400,
        "duplicate_request_id",
        `request_id ${requestId} was already used`,
        path,
        "request_id",
      );
    }
    this.requestIds.set(key, "claimed");
    return requestId;
  }

  private acct(id: string, path: string): Account {
    const a = this.accounts.get(id);
    if (!a) throw new AirwallexError(404, "not_found", `Account ${id} not found`, path);
    return a;
  }

  private bal(a: Account, ccy: Currency): bigint {
    return a.balances.get(ccy) ?? 0n;
  }

  private credit(a: Account, ccy: Currency, minor: bigint): void {
    a.balances.set(ccy, this.bal(a, ccy) + minor);
  }

  private debit(a: Account, ccy: Currency, minor: bigint, code: string, path: string): void {
    if (this.bal(a, ccy) < minor) {
      throw new AirwallexError(400, code, `Insufficient ${ccy} balance`, path);
    }
    a.balances.set(ccy, this.bal(a, ccy) - minor);
  }

  private emit(name: AwxEvent["name"], accountId: string, object: object): void {
    const e: AwxEvent = {
      id: `evt_${randomUUID().slice(0, 16)}`,
      name,
      account_id: accountId,
      created_at: this.iso(),
      data: { object: structuredClone(object) as Record<string, unknown> },
    };
    for (const l of this.listeners) l(e);
  }

  private ccy(v: unknown, path: string, field: string): Currency {
    if (typeof v !== "string" || !isCurrency(v))
      throw new AirwallexError(400, "001", `${field} is invalid`, path, field);
    return v;
  }

  // ───────────────────────────────── accounts ─────────────────────────────────

  private createAccount(body: Record<string, unknown>): AwxAccount {
    if (!body.account_details)
      throw new AirwallexError(
        400,
        "001",
        "account_details is required",
        "/accounts/create",
        "account_details",
      );
    if (body.request_id !== undefined) this.claimRequestId("accounts", body.request_id, "/accounts/create");
    const id = `acct_${randomUUID().replace(/-/g, "").slice(0, 22)}`;
    const record: AwxAccount = {
      id,
      status: "CREATED",
      account_details: structuredClone(body.account_details as AwxAccount["account_details"]),
      nickname: body.nickname as string | undefined,
      created_at: this.iso(),
    };
    this.accounts.set(id, { record, balances: new Map() });
    return record;
  }

  private updateAccount(id: string, body: Record<string, unknown>): AwxAccount {
    const a = this.acct(id, "/accounts/update");
    if (a.record.status !== "CREATED")
      throw new AirwallexError(400, "account_locked", "Fields are locked after submit", "/accounts/update");
    const details = body.account_details as AwxAccount["account_details"] | undefined;
    if (details?.business_details) {
      a.record.account_details.business_details = {
        ...a.record.account_details.business_details,
        ...details.business_details,
      };
    }
    // Mirrors sandbox: adding a business person on update does not persist.
    return a.record;
  }

  private submitAccount(id: string): AwxAccount {
    const a = this.acct(id, "/accounts/submit");
    a.record.status = "SUBMITTED";
    return a.record;
  }

  private activateAccount(id: string, body: Record<string, unknown>): AwxAccount {
    const a = this.acct(id, "/simulation/accounts/update_status");
    if (body.next_status !== "ACTIVE")
      throw new AirwallexError(400, "001", "Only ACTIVE is simulated", "/simulation/accounts/update_status");
    if (a.record.status === "CREATED" && body.force !== true) {
      throw new AirwallexError(
        400,
        "invalid_status",
        "Submit the account first or pass force:true",
        "/simulation/accounts/update_status",
      );
    }
    a.record.status = "ACTIVE";
    a.activatedAt = this.opts.now();
    this.emit("account.active", id, { id, status: "ACTIVE" });
    return a.record;
  }

  private getAccount(id: string): AwxAccount {
    return this.acct(id, `/accounts/${id}`).record;
  }

  private hasEin(a: Account): boolean {
    return !!a.record.account_details.business_details?.business_identifiers?.some(
      (b) => b.type === "EIN" || b.type === "BRN",
    );
  }

  // ───────────────────────────── global accounts & deposits ─────────────────────────────

  private listGlobalAccounts(owner: string): AwxList<AwxGlobalAccount> {
    const items = [...this.globalAccounts.values()]
      .filter((g) => g.owner === owner)
      .map(({ owner: _o, ...g }) => g);
    return { items, has_more: false };
  }

  private createGlobalAccount(owner: string, body: Record<string, unknown>): AwxGlobalAccount {
    const path = "/global_accounts/create";
    this.claimRequestId(`ga:${owner}`, body.request_id, path);
    const country = body.country_code;
    if (country === "BE")
      throw new AirwallexError(400, "unsupported_country", "BE is not supported for Global Accounts", path);
    const feats = body.required_features;
    if (!Array.isArray(feats) || feats.some((f) => typeof f !== "object" || f === null)) {
      throw new AirwallexError(
        400,
        "001",
        "required_features must be objects with currency and transfer_method",
        path,
        "required_features",
      );
    }
    const first = feats[0] as { currency: string; transfer_method: string };
    const currency = this.ccy(first.currency, path, "required_features.currency");
    const ga = {
      id: `ga_${randomUUID().slice(0, 12)}`,
      account_number: String(Math.floor(1e9 + Math.random() * 9e9)),
      country_code: String(country),
      currency,
      status: "ACTIVE" as const,
      required_features: feats as AwxGlobalAccount["required_features"],
      owner,
    };
    this.globalAccounts.set(ga.id, ga);
    const { owner: _o, ...pub } = ga;
    return pub;
  }

  private simulateDeposit(req: AwxRequest, body: Record<string, unknown>): AwxDeposit {
    const path = "/simulation/deposit/create";
    const ga = this.globalAccounts.get(String(body.global_account_id));
    if (!ga) throw new AirwallexError(404, "not_found", "global_account_id not found", path);
    if (req.onBehalfOf && ga.owner !== req.onBehalfOf) {
      throw new AirwallexError(403, "forbidden", "Global account belongs to another account", path);
    }
    if (!req.onBehalfOf && ga.owner !== PLATFORM_ACCOUNT) {
      throw new AirwallexError(400, "001", "x-on-behalf-of is required for connected-account deposits", path);
    }
    const ccy = ga.currency as Currency;
    const amount = parseMoney(String(body.amount), ccy);
    // `currency` in the body is silently ignored, like the sandbox.
    this.credit(this.acct(ga.owner, path), ccy, amount.minor);
    const dep: AwxDeposit = {
      id: `dep_${randomUUID().slice(0, 12)}`,
      global_account_id: ga.id,
      amount: Number(toMajor(amount)),
      currency: ccy,
      status: "PENDING",
      payer_name: body.payer_name as string | undefined,
    };
    this.emit("deposit.settled", ga.owner, { ...dep, status: "SETTLED" });
    return dep;
  }

  private balances(owner: string): AwxBalance[] {
    const a = this.acct(owner, "/balances/current");
    return [...a.balances.entries()]
      .sort(([x], [y]) => x.localeCompare(y))
      .map(([currency, minor]) => {
        const amt = Number(toMajor({ currency, minor }));
        return { currency, available_amount: amt, pending_amount: 0, reserved_amount: 0, total_amount: amt };
      });
  }

  // ───────────────────────────────── beneficiaries ─────────────────────────────────

  private validateBeneficiary(payload: AwxBeneficiaryPayload): { status: "OK" } {
    const path = "/beneficiaries/validate";
    if ((payload as unknown as Record<string, unknown>).payment_methods) {
      throw new AirwallexError(400, "001", "transfer_methods is required", path, "transfer_methods");
    }
    if (!payload.beneficiary || !Array.isArray(payload.transfer_methods)) {
      throw new AirwallexError(
        400,
        "001",
        "beneficiary and transfer_methods are required",
        path,
        "transfer_methods",
      );
    }
    const b = payload.beneficiary.bank_details;
    const country = b.bank_country_code;
    if (b.account_routing_type1 === "SORT_CODE")
      throw new AirwallexError(400, "011", "account_routing_type1 is invalid", path, "account_routing_type1");
    if (b.bank_account_category && !["Checking", "Savings"].includes(b.bank_account_category)) {
      throw new AirwallexError(400, "016", "bank_account_category is invalid", path, "bank_account_category");
    }
    if (payload.transfer_methods.includes("SWIFT")) {
      if (!b.iban || !validIban(b.iban))
        throw new AirwallexError(400, "083", "iban is invalid", path, "iban");
      if (!b.swift_code || !validSwift(b.swift_code))
        throw new AirwallexError(400, "010", "swift_code", path, "swift_code");
    } else if (country === "US") {
      if (b.account_routing_type1 !== "aba" || !validAba(b.account_routing_value1 ?? "")) {
        throw new AirwallexError(400, "010", "account_routing_value1", path, "account_routing_value1");
      }
      if (!b.bank_account_category)
        throw new AirwallexError(
          400,
          "016",
          "bank_account_category is required",
          path,
          "bank_account_category",
        );
    } else if (country === "GB") {
      if (!b.bank_name) throw new AirwallexError(400, "001", "bank_name is required", path, "bank_name");
      if (b.account_routing_type1 !== "sort_code" || !validSortCode(b.account_routing_value1 ?? "")) {
        throw new AirwallexError(400, "010", "account_routing_value1", path, "account_routing_value1");
      }
    }
    const addr = payload.beneficiary.address as unknown as Record<string, unknown>;
    if (!addr?.street_address || !addr.city || !addr.country_code) {
      throw new AirwallexError(
        400,
        "001",
        "address.street_address and address.city are required",
        path,
        "address",
      );
    }
    return { status: "OK" };
  }

  private createBeneficiary(owner: string, body: Record<string, unknown>): AwxBeneficiary {
    const payload = body as unknown as AwxBeneficiaryPayload;
    this.validateBeneficiary(payload);
    const id = `ben_${randomUUID().slice(0, 12)}`;
    const ben = { ...structuredClone(payload), id, owner };
    this.beneficiaries.set(id, ben);
    const { owner: _o, ...pub } = ben;
    return pub;
  }

  // ───────────────────────────────── FX ─────────────────────────────────

  private fxGate(owner: string, path: string): void {
    const a = this.acct(owner, path);
    if (a.record.status !== "ACTIVE")
      throw new AirwallexError(403, "forbidden", "Account is not active", path);
    if (
      owner !== PLATFORM_ACCOUNT &&
      a.activatedAt !== undefined &&
      this.opts.now() - a.activatedAt < this.opts.feeConfigDelayMs
    ) {
      throw new AirwallexError(
        400,
        "unconfigured_client_fee",
        "Client fee is not configured yet; retry in a few minutes",
        path,
      );
    }
  }

  /** Client rate: buy units per 1 sell unit, with spread and optional deterministic drift. */
  clientRate(sell: Currency, buy: Currency): string {
    const usdPer = (c: Currency) => Number(this.opts.baseRates[c] ?? Number.NaN);
    const mid = usdPer(buy) / usdPer(sell);
    if (!Number.isFinite(mid))
      throw new AirwallexError(400, "unsupported_currency_pair", `${sell}/${buy}`, "/fx");
    const minutes = (this.opts.now() - this.startedAt) / 60_000;
    const drift = 1 + (this.opts.driftBpsPerMinute * minutes) / 10_000;
    const client = mid * drift * (1 - this.opts.spreadBps / 10_000);
    return client.toFixed(6);
  }

  private rate(owner: string, q: Record<string, string>) {
    this.fxGate(owner, "/fx/rates/current");
    const sell = this.ccy(q.sell_currency, "/fx/rates/current", "sell_currency");
    const buy = this.ccy(q.buy_currency, "/fx/rates/current", "buy_currency");
    return { buy_currency: buy, sell_currency: sell, rate: Number(this.clientRate(sell, buy)) };
  }

  private createQuote(owner: string, body: Record<string, unknown>): AwxQuote {
    const path = "/fx/quotes/create";
    this.fxGate(owner, path);
    const sell = this.ccy(body.sell_currency, path, "sell_currency");
    const buy = this.ccy(body.buy_currency, path, "buy_currency");
    const rateText = this.clientRate(sell, buy);
    const rate = parseRate(rateText);
    let buyAmt: string;
    let sellAmt: string;
    if (body.buy_amount !== undefined) {
      const b = parseMoney(String(body.buy_amount), buy);
      buyAmt = toMajor(b);
      sellAmt = toMajor(sellNeededFor(b, sell, rate));
    } else if (body.sell_amount !== undefined) {
      const s = parseMoney(String(body.sell_amount), sell);
      sellAmt = toMajor(s);
      buyAmt = toMajor(convert(s, buy, rate, "down"));
    } else {
      throw new AirwallexError(400, "001", "buy_amount or sell_amount is required", path);
    }
    const now = this.opts.now();
    const q = {
      quote_id: `q_${randomUUID().slice(0, 12)}`,
      buy_currency: buy,
      sell_currency: sell,
      buy_amount: Number(buyAmt),
      sell_amount: Number(sellAmt),
      client_rate: Number(rateText),
      valid_from_at: new Date(now).toISOString(),
      valid_to_at: new Date(now + this.opts.quoteTtlMs).toISOString(),
      owner,
      expiresAt: now + this.opts.quoteTtlMs,
    };
    this.quotes.set(q.quote_id, q);
    const { owner: _o, expiresAt: _e, ...pub } = q;
    return pub;
  }

  private createConversion(owner: string, body: Record<string, unknown>): AwxConversion {
    const path = "/fx/conversions/create";
    if (body["x-api-version"]) throw new AirwallexError(400, "incorrect_version", "Stale API version", path);
    this.fxGate(owner, path);
    this.claimRequestId(`conv:${owner}`, body.request_id, path);
    const sell = this.ccy(body.sell_currency, path, "sell_currency");
    const buy = this.ccy(body.buy_currency, path, "buy_currency");
    let rateText = this.clientRate(sell, buy);
    if (body.quote_id) {
      const q = this.quotes.get(String(body.quote_id));
      if (!q || q.owner !== owner)
        throw new AirwallexError(400, "quote_not_found", "quote_id not found for this account", path);
      if (this.opts.now() > q.expiresAt)
        throw new AirwallexError(400, "quote_expired", "Quote has expired", path);
      rateText = q.client_rate.toFixed(6);
    }
    const rate = parseRate(rateText);
    let b: ReturnType<typeof parseMoney>;
    let s: ReturnType<typeof parseMoney>;
    if (body.buy_amount !== undefined) {
      b = parseMoney(String(body.buy_amount), buy);
      s = sellNeededFor(b, sell, rate);
    } else if (body.sell_amount !== undefined) {
      s = parseMoney(String(body.sell_amount), sell);
      b = convert(s, buy, rate, "down");
    } else throw new AirwallexError(400, "001", "buy_amount or sell_amount is required", path);
    const a = this.acct(owner, path);
    this.debit(a, sell, s.minor, "insufficient_funds", path);
    this.credit(a, buy, b.minor);
    const conv = {
      conversion_id: `conv_${randomUUID().slice(0, 12)}`,
      request_id: String(body.request_id),
      status: "SETTLED" as const,
      buy_currency: buy,
      sell_currency: sell,
      buy_amount: Number(toMajor(b)),
      sell_amount: Number(toMajor(s)),
      client_rate: Number(rateText),
      quote_id: body.quote_id as string | undefined,
      created_at: this.iso(),
      owner,
    };
    this.conversions.set(conv.conversion_id, conv);
    const { owner: _o, ...pub } = conv;
    return pub;
  }

  // ───────────────────────────────── transfers ─────────────────────────────────

  private createTransfer(req: AwxRequest, owner: string, body: Record<string, unknown>): AwxTransfer {
    const path = "/transfers/create";
    if (body.payment_currency !== undefined)
      throw new AirwallexError(400, "001", "transfer_currency is required", path, "transfer_currency");
    const requestId = String(body.request_id ?? "");
    if (requestId.length < 10 || requestId.length > 50)
      throw new AirwallexError(400, "018", "request_id must be between 10 and 50 characters", path);
    const method = body.transfer_method;
    if (method !== "LOCAL" && method !== "SWIFT")
      throw new AirwallexError(400, "001", "transfer_method must be LOCAL or SWIFT", path, "transfer_method");
    const ben = this.beneficiaries.get(String(body.beneficiary_id));
    if (!ben || ben.owner !== owner)
      throw new AirwallexError(
        404,
        "beneficiary_not_found",
        "beneficiary_id not found for this account",
        path,
      );
    const a = this.acct(owner, path);
    if (req.onBehalfOf && !this.hasEin(a)) {
      throw new AirwallexError(
        400,
        body.payer ? "048" : "001",
        body.payer ? "payer is invalid" : "payer is required",
        path,
        "payer",
      );
    }
    if (!body.reference) throw new AirwallexError(400, "001", "reference is required", path, "reference");
    const ccy = this.ccy(body.transfer_currency, path, "transfer_currency");
    const amount = parseMoney(String(body.transfer_amount), ccy);
    const fee = method === "SWIFT" ? parseMoney(this.opts.swiftFees[ccy] ?? "0", ccy) : parseMoney("0", ccy);
    this.claimRequestId(`tfr:${owner}`, requestId, path, 10);
    this.debit(a, ccy, amount.minor + fee.minor, "balance_insufficient", path);
    const now = this.iso();
    const t = {
      id: `tfr_${randomUUID().slice(0, 12)}`,
      request_id: requestId,
      beneficiary_id: ben.id,
      status: "PROCESSING" as const,
      transfer_amount: Number(toMajor(amount)),
      transfer_currency: ccy,
      source_currency: String(body.source_currency ?? ccy),
      transfer_method: method as "LOCAL" | "SWIFT",
      fee_amount: Number(toMajor(fee)),
      fee_currency: ccy,
      reference: String(body.reference),
      reason: String(body.reason ?? "wages_salary"),
      created_at: now,
      updated_at: now,
      owner,
    };
    this.transfers.set(t.id, t);
    this.emit("payout.transfer.processing", owner, this.pub(t));
    return this.pub(t);
  }

  private pub(t: AwxTransfer & { owner: string }): AwxTransfer {
    const { owner: _o, ...rest } = t;
    return rest;
  }

  private listTransfers(owner: string, q: Record<string, string>): AwxList<AwxTransfer> {
    const items = [...this.transfers.values()]
      .filter((t) => t.owner === owner && (!q.request_id || t.request_id === q.request_id))
      .map((t) => this.pub(t));
    return { items, has_more: false };
  }

  private getTransfer(owner: string, id: string): AwxTransfer {
    const t = this.transfers.get(id);
    if (!t || t.owner !== owner)
      throw new AirwallexError(404, "not_found", `Transfer ${id} not found`, `/transfers/${id}`);
    return this.pub(t);
  }

  private transitionTransfer(
    req: AwxRequest,
    owner: string,
    id: string,
    body: Record<string, unknown>,
  ): AwxTransfer {
    const path = `/simulation/transfers/${id}/transition`;
    if (!req.onBehalfOf)
      throw new AirwallexError(400, "001", "x-on-behalf-of is required for transfer simulation", path);
    const t = this.transfers.get(id);
    if (!t || t.owner !== owner) throw new AirwallexError(404, "not_found", `Transfer ${id} not found`, path);
    const next = String(body.next_status);
    const allowed: Record<string, string[]> = {
      PROCESSING: ["SENT", "PAID", "FAILED", "CANCELLED"],
      SENT: ["PAID", "FAILED"],
      PAID: [],
      CANCELLED: [],
    };
    if (!allowed[t.status]?.includes(next))
      throw new AirwallexError(400, "invalid_transition", `${t.status} → ${next} not allowed`, path);
    t.updated_at = this.iso();
    if (next === "SENT") {
      t.status = "SENT";
      this.emit("payout.transfer.sent", owner, this.pub(t));
    } else if (next === "PAID") {
      t.status = "PAID";
      this.emit("payout.transfer.paid", owner, this.pub(t));
    } else {
      // Failures end in CANCELLED. A chosen failure_type only applies after SENT.
      const wasSent = t.status === "SENT";
      t.status = "CANCELLED";
      t.failure_type = wasSent && body.failure_type ? String(body.failure_type) : "simulation";
      t.failure_reason =
        wasSent && body.failure_type ? describeFailure(String(body.failure_type)) : "simulation";
      const ccy = t.transfer_currency as Currency;
      // Funds return to the employer's wallet (the fee is not refunded on a bank return).
      this.credit(this.acct(owner, path), ccy, parseMoney(String(t.transfer_amount), ccy).minor);
      this.emit("payout.transfer.failed", owner, this.pub(t));
      this.emit("payout.transfer.cancelled", owner, this.pub(t));
    }
    return this.pub(t);
  }

  // ─────────────────────────── platform money movement ───────────────────────────

  private createCharge(body: Record<string, unknown>): AwxCharge {
    const path = "/charges/create";
    if (!body.reference) throw new AirwallexError(400, "001", "reference is required", path, "reference");
    if (typeof body.source !== "string")
      throw new AirwallexError(400, "001", "source must be an account id string", path, "source");
    const allowedReasons = ["professional_business_services", "wages_salary", "repayment", "other_services"];
    if (!allowedReasons.includes(String(body.reason)))
      throw new AirwallexError(400, "001", "reason is invalid", path, "reason");
    this.claimRequestId("charges", body.request_id, path);
    const ccy = this.ccy(body.currency, path, "currency");
    const amt = parseMoney(String(body.amount), ccy);
    const src = this.acct(body.source, path);
    this.debit(src, ccy, amt.minor, "insufficient_fund", path);
    this.credit(this.acct(PLATFORM_ACCOUNT, path), ccy, amt.minor);
    const c = {
      id: `chg_${randomUUID().slice(0, 12)}`,
      request_id: String(body.request_id),
      amount: Number(toMajor(amt)),
      currency: ccy,
      source: body.source,
      reason: String(body.reason),
      reference: String(body.reference),
      status: "NEW" as const,
      created_at: this.iso(),
      reads: 0,
    };
    this.charges.set(c.id, c);
    const { reads: _r, ...pub } = c;
    return pub;
  }

  private createCaTransfer(body: Record<string, unknown>): AwxConnectedAccountTransfer {
    const path = "/connected_account_transfers/create";
    if (!body.reference) throw new AirwallexError(400, "001", "reference is required", path, "reference");
    if (typeof body.destination !== "string")
      throw new AirwallexError(400, "001", "destination must be an account id string", path, "destination");
    this.claimRequestId("catransfers", body.request_id, path);
    const ccy = this.ccy(body.currency, path, "currency");
    const amt = parseMoney(String(body.amount), ccy);
    this.debit(this.acct(PLATFORM_ACCOUNT, path), ccy, amt.minor, "insufficient_fund", path);
    this.credit(this.acct(body.destination, path), ccy, amt.minor);
    const t = {
      id: `cat_${randomUUID().slice(0, 12)}`,
      request_id: String(body.request_id),
      amount: Number(toMajor(amt)),
      currency: ccy,
      destination: body.destination,
      reason: String(body.reason ?? "wages_salary"),
      reference: String(body.reference),
      status: "NEW" as const,
      created_at: this.iso(),
      reads: 0,
    };
    this.catransfers.set(t.id, t);
    const { reads: _r, ...pub } = t;
    return pub;
  }

  private readMovement<T extends { status: string; reads: number }>(
    store: Map<string, T>,
    id: string,
    path: string,
  ): Omit<T, "reads"> {
    const m = store.get(id);
    if (!m) throw new AirwallexError(404, "not_found", `${id} not found`, path);
    m.reads++;
    if (m.status === "NEW" && m.reads >= this.opts.settleAfterReads) m.status = "SETTLED";
    const { reads: _r, ...pub } = m;
    return pub;
  }

  /** Fingerprint of the simulator's full money state (for reconciliation tests). */
  fingerprint(): string {
    const parts = [...this.accounts.entries()].map(
      ([id, a]) => `${id}:${[...a.balances.entries()].map(([c, v]) => `${c}=${v}`).join(",")}`,
    );
    return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
  }
}

function describeFailure(type: string): string {
  const map: Record<string, string> = {
    BANK_RETURN: "Beneficiary bank returned the payment (account closed)",
    RECALL: "Payment recalled at sender's request",
    INVALID_ACCOUNT: "Beneficiary account number not found",
    COMPLIANCE_REJECT: "Payment rejected during compliance review",
  };
  return map[type] ?? type;
}
