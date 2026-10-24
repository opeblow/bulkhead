import type { CallRecord } from "@bulkhead/airwallex";
import type { ApprovalStatus, ApprovalSubject, MoneyDTO } from "@bulkhead/core";
import type { ParsedSubmission, ShortfallAdvice, ShortfallOption } from "./advisor/types.js";
import type { SubmissionChannel } from "./scenario.js";

export type Tone = "neutral" | "good" | "warn" | "bad" | "agent" | "policy" | "operator" | "airwallex";

export interface TimelineItem {
  readonly id: string;
  readonly seq: number;
  readonly at: string;
  readonly tenant: string | null;
  readonly kind: string;
  readonly title: string;
  readonly detail?: string;
  readonly tone: Tone;
  readonly data?: unknown;
}

export type LineStatus =
  | "queued"
  | "awaiting_approval"
  | "held"
  | "converting"
  | "paying"
  | "processing"
  | "sent"
  | "paid"
  | "failed";

export interface LineState {
  contractorId: string;
  name: string;
  role: string;
  country: string;
  method: "LOCAL" | "SWIFT";
  amount: MoneyDTO;
  fee: MoneyDTO;
  status: LineStatus;
  note?: string;
  transferId?: string;
  requestId?: string;
  beneficiaryId?: string;
  failure?: { type: string; reason: string; summary?: string; nextSteps?: readonly string[] };
}

export type LaneStatus =
  | "idle"
  | "intake"
  | "pricing"
  | "awaiting_funds"
  | "short"
  | "executing"
  | "awaiting_approval"
  | "settling_fee"
  | "complete"
  | "partial"
  | "held";

export interface QuoteDTO {
  fundingRequired: MoneyDTO;
  fundingAvailable: MoneyDTO;
  shortfall: MoneyDTO;
  platformFee: MoneyDTO;
  grossInFunding: MoneyDTO;
  fundable: boolean;
  conversions: { buy: MoneyDTO; sell: MoneyDTO; rate: string; quoteId?: string }[];
  requirements: {
    currency: string;
    payouts: MoneyDTO;
    transferFees: MoneyDTO;
    required: MoneyDTO;
    onHand: MoneyDTO;
    toBuy: MoneyDTO;
  }[];
  asOf: string;
}

export interface LaneState {
  tenant: string;
  key: "A" | "B" | "C";
  legalName: string;
  shortName: string;
  status: LaneStatus;
  statusText: string;
  balances: MoneyDTO[];
  lines: LineState[];
  quote?: QuoteDTO;
  shortfall?: {
    options: ShortfallOption[];
    advice?: ShortfallAdvice;
    bridgeApprovalId?: string;
    resolution?: string;
  };
  fee?: { amount: MoneyDTO; status: "pending" | "NEW" | "SETTLED" | "FAILED" | "skipped"; chargeId?: string };
  bridge?: {
    amount: MoneyDTO;
    status: "requested" | "NEW" | "SETTLED" | "rejected" | "superseded" | "repaid";
    transferId?: string;
  };
  submission: {
    channel: SubmissionChannel;
    from: string;
    receivedAt: string;
    text: string;
    parsed?: ParsedSubmission;
  };
}

export interface RunState {
  id: string;
  status: "running" | "waiting" | "complete";
  startedAt: string;
  finishedAt?: string;
  lanes: LaneState[];
  options: RunOptions;
}

export interface RunOptions {
  /** Scripted mid-run deposit for the unfunded employer (the Track 6 twist). */
  readonly scriptedDeposit?: boolean;
  /** Contractor slug whose payout the bank returns (exception handling demo). */
  readonly injectBankReturn?: string | null;
}

export interface ApprovalDTO {
  id: string;
  title: string;
  summary: string;
  status: ApprovalStatus;
  digest: string;
  subject: ApprovalSubject;
  requestedAt: string;
  decidedAt?: string;
  decidedBy?: string;
  note?: string;
  tenantName: string;
}

export interface Proofs {
  isolation: { ok: boolean; journals: number; violations: number };
  headerCoverage: { ok: boolean; tenantCalls: number; missing: number };
  auditChain: { ok: boolean; length: number; head: string };
  reconciliation: {
    ok: boolean;
    rows: { tenant: string; name: string; currency: string; expected: string; actual: string; ok: boolean }[];
  };
  duplicatePayouts: { ok: boolean; payouts: number; unique: number };
}

export interface EmployerDTO {
  tenant: string;
  key: "A" | "B" | "C";
  legalName: string;
  shortName: string;
  balances: MoneyDTO[];
  contractors: {
    id: string;
    name: string;
    role: string;
    country: string;
    currency: string;
    method: string;
    bank: string;
  }[];
  globalAccountId?: string;
}

export interface Snapshot {
  version: number;
  generatedAt: string;
  mode: { airwallex: "simulator" | "sandbox"; advisor: "claude" | "deterministic"; model?: string };
  bootstrapped: boolean;
  platform: {
    tenant: string;
    balances: MoneyDTO[];
    bridgeCapital: MoneyDTO;
    bridgeUsed: MoneyDTO;
    bridgeFloor: MoneyDTO;
    bridgeOutstanding: { tenant: string; amount: MoneyDTO }[];
  };
  employers: EmployerDTO[];
  run: RunState | null;
  approvals: ApprovalDTO[];
  timeline: TimelineItem[];
  calls: CallRecord[];
  proofs: Proofs | null;
  /** The number Bulkhead refuses to use: all employer balances summed. Display only. */
  naiveAggregate: MoneyDTO;
  ledger: {
    id: string;
    at: string;
    kind: string;
    tenant: string;
    memo: string;
    legs: { owner: string; account: string; amount: MoneyDTO }[];
  }[];
}
