import { describe, expect, it } from "vitest";
import { checkBinding, digestSubject, requestApproval } from "../src/approvals.js";
import { AuditLog, type AuditRecord, verifyChain } from "../src/audit.js";
import { tenantId } from "../src/ids.js";
import { Ledger, verifyIsolation } from "../src/ledger.js";
import { dto, parseMoney } from "../src/money.js";
import { canTransition, isInsufficientFunds, isTerminal } from "../src/transfers.js";

const B = tenantId("acct_b");
const C = tenantId("acct_c");
const usd = (s: string) => parseMoney(s, "USD");

describe("approvals are bound to what the approver saw", () => {
  const subject = {
    action: "bridge_advance" as const,
    tenant: B,
    amount: dto(usd("1604.21")),
    counterparty: "Fjord & Pine Studio",
    terms: { repay: "on next deposit" },
    evidence: ["quote:q_1", "balance:acct_b@2026-10-23T09:00Z"],
  };

  it("passes when nothing changed", () => {
    const a = requestApproval(subject, "Bridge", "…");
    a.status = "approved";
    expect(checkBinding(a, { ...subject })).toEqual({ ok: true });
  });

  it("goes stale when the amount changes by one cent", () => {
    const a = requestApproval(subject, "Bridge", "…");
    a.status = "approved";
    const r = checkBinding(a, { ...subject, amount: dto(usd("1604.22")) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.changed).toEqual(["amount"]);
  });

  it("is order-independent in its digest", () => {
    expect(digestSubject(subject)).toBe(digestSubject({ ...subject, terms: { repay: "on next deposit" } }));
  });

  it("refuses unapproved approvals", () => {
    expect(checkBinding(requestApproval(subject, "x", "y"), subject).ok).toBe(false);
  });
});

describe("audit chain", () => {
  it("verifies an untouched chain and detects tampering", () => {
    const log = new AuditLog();
    log.append({ kind: "run.started", actor: "agent", message: "start" });
    log.append({ kind: "payout.created", actor: "agent", tenant: B, message: "pay", data: { amount: 10n } });
    log.append({ kind: "run.finished", actor: "agent", message: "end" });
    expect(verifyChain(log.all()).ok).toBe(true);

    const tampered = log.all().map((r) => ({ ...r })) as AuditRecord[];
    tampered[1] = { ...tampered[1]!, message: "pay (edited)" };
    const v = verifyChain(tampered);
    expect(v.ok).toBe(false);
    expect(v.brokenAt).toBe(2);
  });
});

describe("ledger isolation", () => {
  it("rejects a journal that moves money between two employers", () => {
    const ledger = new Ledger();
    expect(() =>
      ledger.post({
        kind: "payout",
        tenant: B,
        memo: "borrow from C",
        legs: [
          { owner: C, account: "wallet:USD", amount: usd("-100") },
          { owner: B, account: "wallet:USD", amount: usd("100") },
        ],
      }),
    ).toThrow(/multiple tenants/);
  });

  it("rejects unbalanced journals and platform funds outside platform kinds", () => {
    const ledger = new Ledger();
    expect(() =>
      ledger.post({
        kind: "deposit",
        tenant: B,
        memo: "x",
        legs: [{ owner: B, account: "wallet:USD", amount: usd("1") }],
      }),
    ).toThrow(/unbalanced/);
    expect(() =>
      ledger.post({
        kind: "payout",
        tenant: B,
        memo: "x",
        legs: [
          { owner: "platform", account: "wallet:USD", amount: usd("-1") },
          { owner: B, account: "wallet:USD", amount: usd("1") },
        ],
      }),
    ).toThrow(/platform funds/);
  });

  it("accepts a bridge advance from the platform and tracks wallet net", () => {
    const ledger = new Ledger();
    ledger.post({
      kind: "deposit",
      tenant: B,
      memo: "seed",
      legs: [
        { owner: "external", account: "payer", amount: usd("-6000") },
        { owner: B, account: "wallet:USD", amount: usd("6000") },
      ],
    });
    ledger.post({
      kind: "bridge_advance",
      tenant: B,
      memo: "bridge",
      legs: [
        { owner: "platform", account: "bridge_capital", amount: usd("-1500") },
        { owner: B, account: "wallet:USD", amount: usd("1500") },
      ],
    });
    expect(ledger.walletNet(B, "USD").minor).toBe(750000n);
    expect(verifyIsolation(ledger.all()).ok).toBe(true);
  });
});

describe("transfer state machine", () => {
  it("knows CANCELLED is terminal failure and SENT is in flight", () => {
    expect(isTerminal("SENT")).toBe(false);
    expect(isTerminal("CANCELLED")).toBe(true);
    expect(canTransition("PAID", "CANCELLED")).toBe(false);
    expect(canTransition("SENT", "CANCELLED")).toBe(true);
  });

  it("recognises all three insufficient-funds codes", () => {
    for (const c of ["balance_insufficient", "insufficient_fund", "insufficient_funds"])
      expect(isInsufficientFunds(c)).toBe(true);
    expect(isInsufficientFunds("forbidden")).toBe(false);
  });
});
