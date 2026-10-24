import type { ContractorId, TenantId } from "./ids.js";
import type { Currency, Money } from "./money.js";

/** Airwallex `transfers/create` accepts only LOCAL and SWIFT. Always set explicitly per contractor. */
export type TransferMethod = "LOCAL" | "SWIFT";

export interface Employer {
  readonly tenant: TenantId;
  readonly legalName: string;
  readonly shortName: string;
  /** Wallet currency the employer funds payroll from. */
  readonly fundingCurrency: Currency;
  readonly country: string;
  readonly contact: string;
}

export interface BankDetails {
  readonly accountName: string;
  readonly bankCountry: string;
  readonly bankName?: string;
  readonly accountNumber?: string;
  readonly routingType?: "aba" | "sort_code";
  readonly routingValue?: string;
  readonly iban?: string;
  readonly swiftCode?: string;
  readonly accountCategory?: "Checking" | "Savings";
}

export interface Address {
  readonly street: string;
  readonly city: string;
  readonly state?: string;
  readonly postcode: string;
  readonly countryCode: string;
}

export interface Contractor {
  readonly id: ContractorId;
  readonly tenant: TenantId;
  readonly name: string;
  readonly email: string;
  readonly role: string;
  readonly country: string;
  readonly payoutCurrency: Currency;
  readonly method: TransferMethod;
  readonly bank: BankDetails;
  readonly address: Address;
  /** 1 = pay first when funds are rationed inside the employer's own compartment. */
  readonly priority: number;
  beneficiaryId?: string;
}

export interface PayrollLine {
  readonly contractorId: ContractorId;
  readonly tenant: TenantId;
  readonly amount: Money;
  readonly memo: string;
  readonly dueDate: string;
}

export interface PlatformFeeSchedule {
  /** Percentage of gross payroll (in funding currency) in basis points. */
  readonly bps: number;
  /** Flat per-payout fee in funding currency, major units. */
  readonly perPayout: string;
}

export interface FeeSchedule {
  /** Flat Airwallex SWIFT fee per payout, charged in the payout currency from the same wallet. */
  readonly swift: Partial<Record<Currency, string>>;
  readonly platform: PlatformFeeSchedule;
}

/** Sandbox-observed defaults (see docs/airwallex-integration.md). */
export const DEFAULT_FEES: FeeSchedule = {
  swift: { EUR: "12.85", GBP: "10.95", USD: "15.00" },
  platform: { bps: 50, perPayout: "2.00" },
};
