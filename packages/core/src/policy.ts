import type { TenantId } from "./ids.js";
import { gte, lt, type Money, parseMoney, sub } from "./money.js";

/**
 * Bulkhead's policy engine. Pure, deterministic and exhaustively tested. The model can
 * propose; only this function decides whether a money-moving action may run.
 */

export type RuleId =
  | "TENANT_ISOLATION"
  | "FEES_BEFORE_CONVERSION"
  | "BRIDGE_REQUIRES_APPROVAL"
  | "BRIDGE_CAPITAL_FLOOR"
  | "BRIDGE_PER_EMPLOYER_CAP"
  | "BENEFICIARY_CHANGE_REVIEW"
  | "FEE_AFTER_PAYROLL"
  | "FEE_APPROVAL_THRESHOLD"
  | "DUPLICATE_PAYOUT_LOCK"
  | "QUOTE_DRIFT";

export type PolicyAction =
  | {
      kind: "convert";
      tenant: TenantId;
      /** Whose wallet the sell side debits. Must equal tenant. */
      sourceTenant: TenantId;
      sell: Money;
      buy: Money;
      /** Total payouts + transfer fees required in buy currency. */
      requiredInBuyCurrency: Money;
      /** Buy-currency balance already held by this tenant before converting. */
      onHandInBuyCurrency: Money;
    }
  | {
      kind: "payout";
      tenant: TenantId;
      sourceTenant: TenantId;
      payoutKey: string;
      amount: Money;
    }
  | {
      kind: "charge_fee";
      tenant: TenantId;
      amount: Money;
      payrollComplete: boolean;
    }
  | {
      kind: "bridge_advance";
      tenant: TenantId;
      amount: Money;
    }
  | {
      kind: "cross_tenant_transfer";
      from: TenantId;
      to: TenantId;
      amount: Money;
    }
  | {
      kind: "beneficiary_change";
      tenant: TenantId;
      contractorName: string;
      changedFields: readonly string[];
    }
  | {
      kind: "rate_check";
      tenant: TenantId;
      approvedRate: string;
      currentRate: string;
    };

export interface PolicyConfig {
  /** Platform-owned capital available for bridge advances (never another employer's money). */
  readonly bridgeCapital: Money;
  /** Bridge capital that must remain untouched. */
  readonly bridgeReserveFloor: Money;
  /** Maximum outstanding bridge per employer. */
  readonly bridgePerEmployerCap: Money;
  /** Platform fee charges above this need a human. */
  readonly feeAutoApproveMax: Money;
  /** Allowed movement between approved and executable FX rate, in basis points. */
  readonly quoteDriftToleranceBps: number;
}

export const DEFAULT_POLICY: PolicyConfig = {
  bridgeCapital: parseMoney("5000", "USD"),
  bridgeReserveFloor: parseMoney("2000", "USD"),
  bridgePerEmployerCap: parseMoney("2500", "USD"),
  feeAutoApproveMax: parseMoney("250", "USD"),
  quoteDriftToleranceBps: 25,
};

export interface PolicyState {
  readonly bridgeOutstanding: ReadonlyMap<TenantId, Money>;
  readonly bridgeCapitalUsed: Money;
  readonly issuedPayoutKeys: ReadonlySet<string>;
}

export type Outcome = "allow" | "require_approval" | "deny";

export interface RuleResult {
  readonly rule: RuleId;
  readonly outcome: Outcome;
  readonly reason: string;
}

export interface Decision {
  readonly outcome: Outcome;
  readonly results: readonly RuleResult[];
  /** The decisive reasons (all denials, else all approval requirements, else allows). */
  readonly reasons: readonly string[];
}

function decide(results: RuleResult[]): Decision {
  const deny = results.filter((r) => r.outcome === "deny");
  const approve = results.filter((r) => r.outcome === "require_approval");
  const outcome: Outcome = deny.length ? "deny" : approve.length ? "require_approval" : "allow";
  const decisive = deny.length ? deny : approve.length ? approve : results;
  return { outcome, results, reasons: decisive.map((r) => r.reason) };
}

export function evaluate(action: PolicyAction, config: PolicyConfig, state: PolicyState): Decision {
  const results: RuleResult[] = [];
  switch (action.kind) {
    case "cross_tenant_transfer": {
      results.push({
        rule: "TENANT_ISOLATION",
        outcome: "deny",
        reason: `Moving ${action.from}'s funds to ${action.to} is never permitted, even though the platform could execute it.`,
      });
      break;
    }
    case "convert": {
      results.push(isolation(action.tenant, action.sourceTenant, "conversion"));
      const covered = sumMoney(action.buy, action.onHandInBuyCurrency);
      results.push(
        gte(covered, action.requiredInBuyCurrency)
          ? {
              rule: "FEES_BEFORE_CONVERSION",
              outcome: "allow",
              reason: "Conversion covers every payout plus its SWIFT fee.",
            }
          : {
              rule: "FEES_BEFORE_CONVERSION",
              outcome: "deny",
              reason: `Conversion of ${action.buy.currency} ${action.buy.minor} minor units leaves the batch short; size it to payouts + fees first.`,
            },
      );
      break;
    }
    case "payout": {
      results.push(isolation(action.tenant, action.sourceTenant, "payout"));
      results.push(
        state.issuedPayoutKeys.has(action.payoutKey)
          ? {
              rule: "DUPLICATE_PAYOUT_LOCK",
              outcome: "deny",
              reason: `A payout for ${action.payoutKey} already exists. Reconcile it before issuing another.`,
            }
          : { rule: "DUPLICATE_PAYOUT_LOCK", outcome: "allow", reason: "First payout for this line." },
      );
      break;
    }
    case "charge_fee": {
      results.push(
        action.payrollComplete
          ? {
              rule: "FEE_AFTER_PAYROLL",
              outcome: "allow",
              reason: "Contractors are paid before the platform.",
            }
          : {
              rule: "FEE_AFTER_PAYROLL",
              outcome: "deny",
              reason: "Platform fee waits until every contractor in this employer's batch is paid or held.",
            },
      );
      results.push(
        lt(config.feeAutoApproveMax, action.amount)
          ? {
              rule: "FEE_APPROVAL_THRESHOLD",
              outcome: "require_approval",
              reason: "Fee exceeds the auto-collect threshold.",
            }
          : {
              rule: "FEE_APPROVAL_THRESHOLD",
              outcome: "allow",
              reason: "Fee within auto-collect threshold.",
            },
      );
      break;
    }
    case "bridge_advance": {
      results.push({
        rule: "BRIDGE_REQUIRES_APPROVAL",
        outcome: "require_approval",
        reason: "A bridge advance lends platform capital; a person must approve the exact amount.",
      });
      const outstanding = state.bridgeOutstanding.get(action.tenant);
      const after = outstanding ? sumMoney(outstanding, action.amount) : action.amount;
      results.push(
        lt(config.bridgePerEmployerCap, after)
          ? {
              rule: "BRIDGE_PER_EMPLOYER_CAP",
              outcome: "deny",
              reason: "Advance would exceed the per-employer bridge cap.",
            }
          : { rule: "BRIDGE_PER_EMPLOYER_CAP", outcome: "allow", reason: "Within per-employer cap." },
      );
      const remaining = sub(sub(config.bridgeCapital, state.bridgeCapitalUsed), action.amount);
      results.push(
        lt(remaining, config.bridgeReserveFloor)
          ? {
              rule: "BRIDGE_CAPITAL_FLOOR",
              outcome: "deny",
              reason: "Advance would breach the platform's bridge reserve floor.",
            }
          : { rule: "BRIDGE_CAPITAL_FLOOR", outcome: "allow", reason: "Reserve floor intact after advance." },
      );
      break;
    }
    case "beneficiary_change": {
      results.push({
        rule: "BENEFICIARY_CHANGE_REVIEW",
        outcome: "require_approval",
        reason: `Bank details for ${action.contractorName} changed (${action.changedFields.join(", ")}). Payroll redirection is a top fraud pattern; confirm out-of-band.`,
      });
      break;
    }
    case "rate_check": {
      const drift = driftBps(action.approvedRate, action.currentRate);
      results.push(
        drift > config.quoteDriftToleranceBps
          ? {
              rule: "QUOTE_DRIFT",
              outcome: "require_approval",
              reason: `Rate moved ${drift} bps since approval (tolerance ${config.quoteDriftToleranceBps}).`,
            }
          : { rule: "QUOTE_DRIFT", outcome: "allow", reason: `Rate drift ${drift} bps within tolerance.` },
      );
      break;
    }
  }
  return decide(results);
}

function isolation(tenant: TenantId, source: TenantId, what: string): RuleResult {
  return tenant === source
    ? { rule: "TENANT_ISOLATION", outcome: "allow", reason: `${what} funded from the employer's own wallet.` }
    : {
        rule: "TENANT_ISOLATION",
        outcome: "deny",
        reason: `${what} for ${tenant} would draw on ${source}'s wallet. Each employer funds only its own payroll.`,
      };
}

function sumMoney(a: Money, b: Money): Money {
  return { currency: a.currency, minor: a.minor + b.minor };
}

export function driftBps(a: string, b: string): number {
  const x = Number(a);
  const y = Number(b);
  if (!(x > 0)) return Number.POSITIVE_INFINITY;
  return Math.round((Math.abs(y - x) / x) * 10_000);
}
