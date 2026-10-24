import { describe, expect, it } from "vitest";
import { tenantId } from "../src/ids.js";
import { parseMoney, zero } from "../src/money.js";
import { DEFAULT_POLICY, evaluate, type PolicyState } from "../src/policy.js";

const A = tenantId("acct_a");
const B = tenantId("acct_b");
const C = tenantId("acct_c");
const usd = (s: string) => parseMoney(s, "USD");
const eur = (s: string) => parseMoney(s, "EUR");

const state: PolicyState = {
  bridgeOutstanding: new Map(),
  bridgeCapitalUsed: zero("USD"),
  issuedPayoutKeys: new Set(["run1:jonas"]),
};

describe("policy: tenant isolation", () => {
  it("denies any cross-tenant transfer, whatever the amount", () => {
    const d = evaluate(
      { kind: "cross_tenant_transfer", from: C, to: B, amount: usd("0.01") },
      DEFAULT_POLICY,
      state,
    );
    expect(d.outcome).toBe("deny");
    expect(d.results[0]?.rule).toBe("TENANT_ISOLATION");
  });

  it("denies a payout for B funded from C's wallet", () => {
    const d = evaluate(
      { kind: "payout", tenant: B, sourceTenant: C, payoutKey: "run1:priya", amount: usd("10") },
      DEFAULT_POLICY,
      state,
    );
    expect(d.outcome).toBe("deny");
    expect(d.reasons.join(" ")).toMatch(/own payroll/);
  });

  it("denies a conversion for A that debits B", () => {
    const d = evaluate(
      {
        kind: "convert",
        tenant: A,
        sourceTenant: B,
        sell: usd("100"),
        buy: eur("92"),
        requiredInBuyCurrency: eur("92"),
        onHandInBuyCurrency: eur("0"),
      },
      DEFAULT_POLICY,
      state,
    );
    expect(d.outcome).toBe("deny");
  });
});

describe("policy: money rules", () => {
  it("denies a conversion that ignores the SWIFT fee", () => {
    const d = evaluate(
      {
        kind: "convert",
        tenant: B,
        sourceTenant: B,
        sell: usd("4347.83"),
        buy: eur("4000"),
        requiredInBuyCurrency: eur("4012.85"),
        onHandInBuyCurrency: eur("0"),
      },
      DEFAULT_POLICY,
      state,
    );
    expect(d.outcome).toBe("deny");
    expect(d.results.find((r) => r.rule === "FEES_BEFORE_CONVERSION")?.outcome).toBe("deny");
  });

  it("allows a correctly sized conversion", () => {
    const d = evaluate(
      {
        kind: "convert",
        tenant: B,
        sourceTenant: B,
        sell: usd("4361.80"),
        buy: eur("4012.85"),
        requiredInBuyCurrency: eur("4012.85"),
        onHandInBuyCurrency: eur("0"),
      },
      DEFAULT_POLICY,
      state,
    );
    expect(d.outcome).toBe("allow");
  });

  it("locks duplicate payouts", () => {
    const d = evaluate(
      { kind: "payout", tenant: B, sourceTenant: B, payoutKey: "run1:jonas", amount: eur("4000") },
      DEFAULT_POLICY,
      state,
    );
    expect(d.outcome).toBe("deny");
    expect(d.results.find((r) => r.rule === "DUPLICATE_PAYOUT_LOCK")?.outcome).toBe("deny");
  });

  it("collects the platform fee only after payroll", () => {
    expect(
      evaluate(
        { kind: "charge_fee", tenant: B, amount: usd("40"), payrollComplete: false },
        DEFAULT_POLICY,
        state,
      ).outcome,
    ).toBe("deny");
    expect(
      evaluate(
        { kind: "charge_fee", tenant: B, amount: usd("40"), payrollComplete: true },
        DEFAULT_POLICY,
        state,
      ).outcome,
    ).toBe("allow");
    expect(
      evaluate(
        { kind: "charge_fee", tenant: B, amount: usd("400"), payrollComplete: true },
        DEFAULT_POLICY,
        state,
      ).outcome,
    ).toBe("require_approval");
  });
});

describe("policy: bridge advances", () => {
  it("always needs a person", () => {
    const d = evaluate({ kind: "bridge_advance", tenant: B, amount: usd("1500") }, DEFAULT_POLICY, state);
    expect(d.outcome).toBe("require_approval");
  });

  it("respects the per-employer cap", () => {
    const d = evaluate({ kind: "bridge_advance", tenant: B, amount: usd("2600") }, DEFAULT_POLICY, state);
    expect(d.outcome).toBe("deny");
  });

  it("respects the reserve floor on platform capital", () => {
    const d = evaluate({ kind: "bridge_advance", tenant: B, amount: usd("1500") }, DEFAULT_POLICY, {
      ...state,
      bridgeCapitalUsed: usd("2000"),
    });
    expect(d.outcome).toBe("deny");
    expect(d.results.find((r) => r.rule === "BRIDGE_CAPITAL_FLOOR")?.outcome).toBe("deny");
  });
});

describe("policy: fraud and drift", () => {
  it("routes bank-detail changes to a person", () => {
    const d = evaluate(
      { kind: "beneficiary_change", tenant: B, contractorName: "Priya", changedFields: ["account_number"] },
      DEFAULT_POLICY,
      state,
    );
    expect(d.outcome).toBe("require_approval");
  });

  it("re-asks when the FX rate drifts past tolerance", () => {
    expect(
      evaluate(
        { kind: "rate_check", tenant: B, approvedRate: "0.9200", currentRate: "0.9210" },
        DEFAULT_POLICY,
        state,
      ).outcome,
    ).toBe("allow");
    expect(
      evaluate(
        { kind: "rate_check", tenant: B, approvedRate: "0.9200", currentRate: "0.9300" },
        DEFAULT_POLICY,
        state,
      ).outcome,
    ).toBe("require_approval");
  });
});
