import type { RequestId, TenantId } from "@bulkhead/core";
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
  AwxGlobalAccount,
  AwxList,
  AwxQuote,
  AwxRequest,
  AwxTransfer,
  Transport,
} from "./types.js";

type Send = <T>(req: AwxRequest & { intent?: string; scope?: "platform" | "tenant" }) => Promise<T>;

/**
 * Platform-level operations: onboarding connected accounts and platform money movement.
 * It has NO method that touches a customer's wallet directly; for that you must ask for a
 * TenantClient, which cannot be constructed without the customer's account id.
 */
export class PlatformClient {
  private readonly send: Send;

  constructor(private readonly transport: Transport) {
    this.send = (req) => (transport as Transport).send(req);
  }

  get mode() {
    return this.transport.kind;
  }

  /** The only way to act on an employer's money. */
  forTenant(tenant: TenantId): TenantClient {
    if (!/^acct_[A-Za-z0-9_-]+$/.test(tenant)) throw new Error(`Invalid connected account id: ${tenant}`);
    return new TenantClient(this.transport, tenant);
  }

  createAccount(body: {
    account_details: unknown;
    nickname?: string;
    request_id?: string;
  }): Promise<AwxAccount> {
    return this.send({
      method: "POST",
      path: "/accounts/create",
      body,
      intent: "Create employer connected account",
      scope: "platform",
    });
  }

  submitAccount(id: string): Promise<AwxAccount> {
    return this.send({
      method: "POST",
      path: `/accounts/${id}/submit`,
      body: {},
      intent: "Submit account for KYB",
      scope: "platform",
    });
  }

  simulateActivate(id: string): Promise<AwxAccount> {
    return this.send({
      method: "POST",
      path: `/simulation/accounts/${id}/update_status`,
      body: { next_status: "ACTIVE", force: true },
      intent: "Simulate account activation (sandbox)",
      scope: "platform",
    });
  }

  getAccount(id: string): Promise<AwxAccount> {
    return this.send({
      method: "GET",
      path: `/accounts/${id}`,
      intent: "Confirm account status",
      scope: "platform",
    });
  }

  platformBalances(): Promise<AwxBalance[]> {
    return this.send({
      method: "GET",
      path: "/balances/current",
      intent: "Read platform wallet",
      scope: "platform",
    });
  }

  /** Platform → employer wallet. Returns NEW; poll until SETTLED. */
  connectedAccountTransfer(body: {
    request_id: RequestId;
    amount: string;
    currency: string;
    destination: TenantId;
    reason: "wages_salary";
    reference: string;
  }): Promise<AwxConnectedAccountTransfer> {
    return this.send({
      method: "POST",
      path: "/connected_account_transfers/create",
      body,
      intent: "Bridge advance: platform → employer",
      scope: "platform",
    });
  }

  getConnectedAccountTransfer(id: string): Promise<AwxConnectedAccountTransfer> {
    return this.send({
      method: "GET",
      path: `/connected_account_transfers/${id}`,
      intent: "Poll bridge settlement",
      scope: "platform",
    });
  }

  /** Employer wallet → platform (fee). Returns NEW; poll until SETTLED. */
  charge(body: {
    request_id: RequestId;
    amount: string;
    currency: string;
    source: TenantId;
    reason: "professional_business_services" | "repayment";
    reference: string;
  }): Promise<AwxCharge> {
    return this.send({
      method: "POST",
      path: "/charges/create",
      body,
      intent: "Collect platform fee",
      scope: "platform",
    });
  }

  getCharge(id: string): Promise<AwxCharge> {
    return this.send({
      method: "GET",
      path: `/charges/${id}`,
      intent: "Poll fee settlement",
      scope: "platform",
    });
  }
}

/**
 * Every call made through a TenantClient carries `x-on-behalf-of: <tenant>`. There is no
 * parameter to override it and no way to call a customer-scoped endpoint without it.
 */
export class TenantClient {
  constructor(
    private readonly transport: Transport,
    readonly tenant: TenantId,
  ) {}

  private call<T>(req: Omit<AwxRequest, "onBehalfOf"> & { intent?: string }): Promise<T> {
    return (this.transport as Transport).send<T>({
      ...req,
      onBehalfOf: this.tenant,
      scope: "tenant",
    } as AwxRequest);
  }

  balances(): Promise<AwxBalance[]> {
    return this.call({ method: "GET", path: "/balances/current", intent: "Read employer wallet" });
  }

  listGlobalAccounts(): Promise<AwxList<AwxGlobalAccount>> {
    return this.call({ method: "GET", path: "/global_accounts", intent: "List employer global accounts" });
  }

  createGlobalAccount(body: {
    request_id: RequestId;
    country_code: string;
    required_features: { currency: string; transfer_method: "LOCAL" | "SWIFT" }[];
  }): Promise<AwxGlobalAccount> {
    return this.call({
      method: "POST",
      path: "/global_accounts/create",
      body,
      intent: "Open employer global account",
    });
  }

  simulateDeposit(body: {
    global_account_id: string;
    amount: string;
    payer_name?: string;
  }): Promise<AwxDeposit> {
    return this.call({
      method: "POST",
      path: "/simulation/deposit/create",
      body,
      intent: "Simulate employer deposit (sandbox)",
    });
  }

  validateBeneficiary(payload: AwxBeneficiaryPayload): Promise<{ status: string }> {
    return this.call({
      method: "POST",
      path: "/beneficiaries/validate",
      body: payload,
      intent: "Validate contractor bank details",
    });
  }

  createBeneficiary(payload: AwxBeneficiaryPayload): Promise<AwxBeneficiary> {
    return this.call({
      method: "POST",
      path: "/beneficiaries/create",
      body: payload,
      intent: "Create contractor beneficiary",
    });
  }

  createQuote(body: {
    sell_currency: string;
    buy_currency: string;
    buy_amount: string;
    validity?: string;
  }): Promise<AwxQuote> {
    return this.call({ method: "POST", path: "/fx/quotes/create", body, intent: "Lock FX quote" });
  }

  convert(body: {
    request_id: RequestId;
    sell_currency: string;
    buy_currency: string;
    buy_amount: string;
    quote_id?: string;
  }): Promise<AwxConversion> {
    return this.call({
      method: "POST",
      path: "/fx/conversions/create",
      body,
      intent: "Convert in employer wallet",
    });
  }

  createTransfer(body: {
    request_id: RequestId;
    beneficiary_id: string;
    transfer_amount: string;
    transfer_currency: string;
    source_currency: string;
    transfer_method: "LOCAL" | "SWIFT";
    reference: string;
    reason: "wages_salary";
  }): Promise<AwxTransfer> {
    return this.call({ method: "POST", path: "/transfers/create", body, intent: "Pay contractor" });
  }

  findTransferByRequestId(requestId: RequestId): Promise<AwxList<AwxTransfer>> {
    return this.call({
      method: "GET",
      path: "/transfers",
      query: { request_id: requestId },
      intent: "Look up transfer by request_id",
    });
  }

  getTransfer(id: string): Promise<AwxTransfer> {
    return this.call({ method: "GET", path: `/transfers/${id}`, intent: "Poll transfer status" });
  }

  simulateTransfer(id: string, next: "SENT" | "PAID" | "FAILED", failureType?: string): Promise<AwxTransfer> {
    return this.call({
      method: "POST",
      path: `/simulation/transfers/${id}/transition`,
      body: failureType ? { next_status: next, failure_type: failureType } : { next_status: next },
      intent: `Simulate transfer → ${next} (sandbox)`,
    });
  }

  /**
   * Create a transfer exactly once. Any non-success is treated as ambiguous: look the
   * request_id up before deciding, so a retry can never create a second payout.
   */
  async createTransferOnce(
    body: Parameters<TenantClient["createTransfer"]>[0],
  ): Promise<{ transfer: AwxTransfer; recovered: boolean }> {
    try {
      return { transfer: await this.createTransfer(body), recovered: false };
    } catch (e) {
      if (!(e instanceof AirwallexError)) throw e;
      if (
        e.code === "balance_insufficient" ||
        e.status === 404 ||
        (e.status === 400 && e.code !== "duplicate_request_id")
      )
        throw e;
      const found = await this.findTransferByRequestId(body.request_id);
      const existing = found.items[0];
      if (existing) return { transfer: existing, recovered: true };
      if (e.ambiguous || e.status === 429) {
        // Not created: safe to retry with the SAME request_id.
        return { transfer: await this.createTransfer(body), recovered: false };
      }
      throw e;
    }
  }
}
