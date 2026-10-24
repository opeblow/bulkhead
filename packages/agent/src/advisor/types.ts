import type { Currency } from "@bulkhead/core";

/**
 * The advisor is the only place a language model is involved. It reads unstructured text,
 * compares options that CODE has already computed and policy has already judged, and writes
 * explanations. It never computes amounts and never calls Airwallex.
 */

export interface RosterEntry {
  readonly name: string;
  readonly payoutCurrency: Currency;
}

export interface ParsedLine {
  readonly contractorName: string;
  readonly amount: string;
  readonly currency: Currency;
  readonly memo?: string;
}

export interface ParsedBankChange {
  readonly contractorName: string;
  readonly bankName?: string;
  readonly sortCode?: string;
  readonly accountNumber?: string;
  readonly iban?: string;
  readonly swiftCode?: string;
}

export interface ParsedSubmission {
  readonly lines: readonly ParsedLine[];
  readonly bankChanges: readonly ParsedBankChange[];
  readonly notes: readonly string[];
  readonly source: "claude" | "deterministic";
}

export interface ShortfallOption {
  readonly id:
    | "pay_priority_then_bridge"
    | "pay_priority_then_wait"
    | "hold_all"
    | "borrow_from_other_employer";
  readonly title: string;
  readonly description: string;
  readonly payNow: readonly string[];
  readonly hold: readonly string[];
  readonly amount?: string;
  readonly policy: "allow" | "require_approval" | "deny";
  readonly policyReasons: readonly string[];
}

export interface ShortfallContext {
  readonly employer: string;
  readonly employerNotes: readonly string[];
  readonly fundingAvailable: string;
  readonly fundingRequired: string;
  readonly shortfall: string;
  readonly lines: readonly { name: string; amount: string; method: string; priority: number }[];
  readonly options: readonly ShortfallOption[];
}

export interface ShortfallAdvice {
  readonly optionId: ShortfallOption["id"];
  readonly rationale: string;
  readonly employerMessage: string;
  readonly source: "claude" | "deterministic";
}

export interface ExceptionContext {
  readonly employer: string;
  readonly contractor: string;
  readonly amount: string;
  readonly failureType: string;
  readonly failureReason: string;
  readonly feeLost: string;
}

export interface ExceptionAdvice {
  readonly summary: string;
  readonly nextSteps: readonly string[];
  readonly source: "claude" | "deterministic";
}

export interface Advisor {
  readonly kind: "claude" | "deterministic";
  readonly model?: string;
  parseSubmission(text: string, roster: readonly RosterEntry[]): Promise<ParsedSubmission>;
  resolveShortfall(ctx: ShortfallContext): Promise<ShortfallAdvice>;
  explainException(ctx: ExceptionContext): Promise<ExceptionAdvice>;
}
