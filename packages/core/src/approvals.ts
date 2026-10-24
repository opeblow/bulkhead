import { createHash, randomUUID } from "node:crypto";
import type { TenantId } from "./ids.js";
import type { MoneyDTO } from "./money.js";

/**
 * Approvals are bound to exactly what the approver saw: action, employer, amount,
 * currency, counterparty, terms and evidence. If any of those change before execution
 * the approval is stale and the agent must ask again.
 */
export interface ApprovalSubject {
  readonly action: "bridge_advance" | "beneficiary_change" | "charge_fee" | "fx_reprice" | "partial_payroll";
  readonly tenant: TenantId;
  readonly amount: MoneyDTO;
  readonly counterparty: string;
  readonly terms: Readonly<Record<string, string>>;
  readonly evidence: readonly string[];
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "stale" | "executed";

export interface Approval {
  readonly id: string;
  readonly subject: ApprovalSubject;
  readonly digest: string;
  readonly title: string;
  readonly summary: string;
  readonly requestedAt: string;
  status: ApprovalStatus;
  decidedAt?: string;
  decidedBy?: string;
  note?: string;
}

/** Canonical JSON: sorted keys, no whitespace. Stable across processes. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function digestSubject(subject: ApprovalSubject): string {
  return createHash("sha256").update(canonicalJson(subject)).digest("hex");
}

export function requestApproval(subject: ApprovalSubject, title: string, summary: string): Approval {
  return {
    id: `apr_${randomUUID().slice(0, 12)}`,
    subject,
    digest: digestSubject(subject),
    title,
    summary,
    requestedAt: new Date().toISOString(),
    status: "pending",
  };
}

export type BindingCheck = { ok: true } | { ok: false; reason: string; changed: string[] };

/** Verify an approval still binds to the action about to execute. */
export function checkBinding(approval: Approval, current: ApprovalSubject): BindingCheck {
  if (approval.status !== "approved") {
    return { ok: false, reason: `Approval is ${approval.status}`, changed: [] };
  }
  if (digestSubject(current) === approval.digest) return { ok: true };
  const a = approval.subject as unknown as Record<string, unknown>;
  const b = current as unknown as Record<string, unknown>;
  const changed = Object.keys({ ...a, ...b }).filter((k) => canonicalJson(a[k]) !== canonicalJson(b[k]));
  return { ok: false, reason: `Approved terms changed: ${changed.join(", ")}`, changed };
}
