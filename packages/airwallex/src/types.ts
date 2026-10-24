/**
 * Wire types for the subset of the Airwallex API Bulkhead uses. Amounts are major units
 * (numbers or decimal strings) exactly as Airwallex sends them; convert with @bulkhead/core.
 */

export type HttpMethod = "GET" | "POST";

export interface AwxRequest {
  readonly method: HttpMethod;
  /** Path below /api/v1, e.g. "/transfers/create". */
  readonly path: string;
  readonly body?: unknown;
  readonly query?: Readonly<Record<string, string>>;
  /** Connected account to act for. Set by TenantClient only. */
  readonly onBehalfOf?: string;
}

export interface Transport {
  send<T>(req: AwxRequest): Promise<T>;
  readonly kind: "simulator" | "sandbox";
}

export type AccountStatus = "CREATED" | "SUBMITTED" | "ACTIVE" | "SUSPENDED";

export interface AwxAccount {
  id: string;
  status: AccountStatus;
  account_details: {
    business_details?: {
      business_name?: string;
      business_identifiers?: { country_code: string; number: string; type: string }[];
      industry_category_code?: string;
      registration_address?: Record<string, string>;
    };
    business_person_details?: unknown[];
  };
  nickname?: string;
  created_at: string;
}

export interface AwxGlobalAccount {
  id: string;
  account_number: string;
  country_code: string;
  currency: string;
  status: "ACTIVE";
  required_features: { currency: string; transfer_method: string }[];
}

export interface AwxBalance {
  currency: string;
  available_amount: number;
  pending_amount: number;
  reserved_amount: number;
  total_amount: number;
}

export interface AwxDeposit {
  id: string;
  global_account_id: string;
  amount: number;
  currency: string;
  status: "PENDING" | "SETTLED";
  payer_name?: string;
}

export interface AwxBeneficiaryPayload {
  beneficiary: {
    entity_type: "PERSONAL" | "COMPANY";
    first_name?: string;
    last_name?: string;
    company_name?: string;
    bank_details: Record<string, string>;
    address: {
      street_address: string;
      city: string;
      state?: string;
      postcode: string;
      country_code: string;
    };
  };
  transfer_methods: ("LOCAL" | "SWIFT")[];
  nickname?: string;
}

export interface AwxBeneficiary extends AwxBeneficiaryPayload {
  id: string;
}

export interface AwxQuote {
  quote_id: string;
  buy_currency: string;
  sell_currency: string;
  buy_amount: number;
  sell_amount: number;
  client_rate: number;
  valid_from_at: string;
  valid_to_at: string;
}

export interface AwxRate {
  buy_currency: string;
  sell_currency: string;
  rate: number;
}

export interface AwxConversion {
  conversion_id: string;
  request_id: string;
  status: "SETTLED";
  buy_currency: string;
  sell_currency: string;
  buy_amount: number;
  sell_amount: number;
  client_rate: number;
  quote_id?: string;
  created_at: string;
}

export type AwxTransferStatus = "PROCESSING" | "SENT" | "PAID" | "CANCELLED";

export interface AwxTransfer {
  id: string;
  request_id: string;
  beneficiary_id: string;
  status: AwxTransferStatus;
  transfer_amount: number;
  transfer_currency: string;
  source_currency: string;
  transfer_method: "LOCAL" | "SWIFT";
  fee_amount: number;
  fee_currency: string;
  reference: string;
  reason: string;
  failure_type?: string;
  failure_reason?: string;
  created_at: string;
  updated_at: string;
}

export type AwxMovementStatus = "NEW" | "PENDING" | "SETTLED" | "FAILED";

export interface AwxCharge {
  id: string;
  request_id: string;
  amount: number;
  currency: string;
  source: string;
  reason: string;
  reference: string;
  status: AwxMovementStatus;
  created_at: string;
}

export interface AwxConnectedAccountTransfer {
  id: string;
  request_id: string;
  amount: number;
  currency: string;
  destination: string;
  reason: string;
  reference: string;
  status: AwxMovementStatus;
  created_at: string;
}

export interface AwxList<T> {
  items: T[];
  has_more: boolean;
}

/** Webhook event as delivered (body). */
export interface AwxEvent {
  id: string;
  name:
    | "payout.transfer.processing"
    | "payout.transfer.sent"
    | "payout.transfer.paid"
    | "payout.transfer.failed"
    | "payout.transfer.cancelled"
    | "deposit.settled"
    | "account.active";
  account_id: string;
  created_at: string;
  data: { object: Record<string, unknown> };
}
