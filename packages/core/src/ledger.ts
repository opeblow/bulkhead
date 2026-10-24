import { randomUUID } from "node:crypto";
import type { TenantId } from "./ids.js";
import { add, type Currency, type Money, zero } from "./money.js";

/**
 * Bulkhead's shadow ledger: a double-entry record of every movement it causes, used to
 * (1) prove tenant isolation and (2) reconcile against Airwallex balances after each run.
 */
export type Owner = TenantId | "platform" | "external";

export interface Leg {
  readonly owner: Owner;
  /** e.g. "wallet:USD", "fx", "contractor:ctr_amara", "airwallex:swift_fee", "bridge_receivable" */
  readonly account: string;
  /** Positive = into the account, negative = out of it. */
  readonly amount: Money;
}

export type JournalKind =
  | "deposit"
  | "conversion"
  | "payout"
  | "transfer_fee"
  | "payout_return"
  | "platform_fee"
  | "bridge_advance"
  | "bridge_repayment";

export interface Journal {
  readonly id: string;
  readonly at: string;
  readonly kind: JournalKind;
  readonly tenant: TenantId;
  readonly memo: string;
  readonly ref?: string;
  readonly legs: readonly Leg[];
}

/** Kinds where the platform itself is a legitimate counterparty of one tenant. */
const PLATFORM_KINDS: ReadonlySet<JournalKind> = new Set([
  "platform_fee",
  "bridge_advance",
  "bridge_repayment",
]);

export class Ledger {
  private readonly journals: Journal[] = [];

  post(j: Omit<Journal, "id" | "at"> & { at?: string }): Journal {
    const journal: Journal = {
      id: `jnl_${randomUUID().slice(0, 12)}`,
      at: j.at ?? new Date().toISOString(),
      ...j,
    };
    const violations = checkJournal(journal);
    if (violations.length) throw new Error(`Ledger rejected ${journal.kind}: ${violations.join("; ")}`);
    this.journals.push(journal);
    return journal;
  }

  all(): readonly Journal[] {
    return this.journals;
  }

  forTenant(tenant: TenantId): readonly Journal[] {
    return this.journals.filter((j) => j.tenant === tenant);
  }

  /** Net movement Bulkhead caused in a tenant wallet (deposits included). */
  walletNet(tenant: TenantId, currency: Currency): Money {
    let total = zero(currency);
    for (const j of this.journals) {
      for (const l of j.legs) {
        if (l.owner === tenant && l.account === `wallet:${currency}`) total = add(total, l.amount);
      }
    }
    return total;
  }
}

/** Validate one journal: balanced per currency, and never touching two different tenants. */
export function checkJournal(j: Journal): string[] {
  const problems: string[] = [];
  const byCcy = new Map<Currency, bigint>();
  for (const l of j.legs) byCcy.set(l.amount.currency, (byCcy.get(l.amount.currency) ?? 0n) + l.amount.minor);
  for (const [ccy, net] of byCcy) if (net !== 0n) problems.push(`unbalanced in ${ccy} by ${net}`);

  const tenants = new Set(j.legs.map((l) => l.owner).filter((o) => o !== "platform" && o !== "external"));
  if (tenants.size > 1) problems.push(`touches multiple tenants: ${[...tenants].join(", ")}`);
  if (tenants.size === 1 && !tenants.has(j.tenant))
    problems.push(`legs belong to ${[...tenants][0]}, journal to ${j.tenant}`);
  if (j.legs.some((l) => l.owner === "platform") && !PLATFORM_KINDS.has(j.kind)) {
    problems.push(`${j.kind} may not involve platform funds`);
  }
  return problems;
}

export interface IsolationReport {
  readonly ok: boolean;
  readonly journalsChecked: number;
  readonly violations: readonly { journal: string; problems: string[] }[];
}

export function verifyIsolation(journals: readonly Journal[]): IsolationReport {
  const violations = journals
    .map((j) => ({ journal: j.id, problems: checkJournal(j) }))
    .filter((v) => v.problems.length > 0);
  return { ok: violations.length === 0, journalsChecked: journals.length, violations };
}
