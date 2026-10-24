import { describe, expect, it } from "vitest";
import { CompartmentBreachError } from "../src/compartment.js";
import { DEFAULT_FEES } from "../src/domain.js";
import { convert, format, parseMoney, sub, toMajor } from "../src/money.js";
import { planWithinCompartment, priceEmployerPayroll } from "../src/pricing.js";
import { A, B, contractor, index, line, rates, wallet } from "./fixtures.js";

const jonas = contractor("jonas", B, { method: "SWIFT", payoutCurrency: "EUR", priority: 2 });
const priya = contractor("priya", B, {
  method: "LOCAL",
  payoutCurrency: "GBP",
  country: "GB",
  priority: 1,
  bank: {
    accountName: "Priya",
    bankCountry: "GB",
    bankName: "Monzo",
    accountNumber: "41926819",
    routingType: "sort_code",
    routingValue: "040004",
  },
});
const contractors = index([jonas, priya]);
const lines = [line(jonas, "4000"), line(priya, "2800")];

describe("priceEmployerPayroll", () => {
  it("adds the SWIFT fee to the conversion BEFORE converting", () => {
    const q = priceEmployerPayroll({
      tenant: B,
      fundingCurrency: "USD",
      lines,
      contractors,
      compartment: wallet(B, "20000"),
      rates,
      fees: DEFAULT_FEES,
    });
    const eur = q.requirements.find((r) => r.currency === "EUR")!;
    expect(toMajor(eur.transferFees)).toBe("12.85");
    expect(toMajor(eur.toBuy)).toBe("4012.85");
    const conv = q.conversions.find((c) => c.buy.currency === "EUR")!;
    expect(toMajor(conv.buy)).toBe("4012.85");
    // The converted amount really covers payout + fee at the quoted rate.
    expect(convert(conv.sell, "EUR", conv.fx.rate, "down").minor).toBeGreaterThanOrEqual(conv.buy.minor);
  });

  it("does not charge a fee for LOCAL payouts and does not infer method from fees", () => {
    const q = priceEmployerPayroll({
      tenant: B,
      fundingCurrency: "USD",
      lines,
      contractors,
      compartment: wallet(B, "20000"),
      rates,
      fees: DEFAULT_FEES,
    });
    const gbp = q.lines.find((l) => l.contractorId === priya.id)!;
    expect(gbp.method).toBe("LOCAL");
    expect(gbp.transferFee.minor).toBe(0n);
  });

  it("uses foreign balances already in the employer's wallet", () => {
    const q = priceEmployerPayroll({
      tenant: B,
      fundingCurrency: "USD",
      lines,
      contractors,
      compartment: wallet(B, "20000", [["EUR", "1000"]]),
      rates,
      fees: DEFAULT_FEES,
    });
    expect(toMajor(q.requirements.find((r) => r.currency === "EUR")!.toBuy)).toBe("3012.85");
  });

  it("reports a precise shortfall when the employer's own wallet cannot cover payroll + fees", () => {
    const q = priceEmployerPayroll({
      tenant: B,
      fundingCurrency: "USD",
      lines,
      contractors,
      compartment: wallet(B, "6000"),
      rates,
      fees: DEFAULT_FEES,
    });
    expect(q.fundable).toBe(false);
    expect(q.shortfall.minor).toBe(sub(q.fundingRequired, parseMoney("6000", "USD")).minor);
    expect(format(q.shortfall)).toMatch(/^\$/);
  });

  it("throws a CompartmentBreachError if handed another employer's balances", () => {
    expect(() =>
      priceEmployerPayroll({
        tenant: B,
        fundingCurrency: "USD",
        lines,
        contractors,
        compartment: wallet(A, "999999"),
        rates,
        fees: DEFAULT_FEES,
      }),
    ).toThrow(CompartmentBreachError);
  });

  it("rejects a payroll line that belongs to another employer", () => {
    const foreign = contractor("mallory", A);
    expect(() =>
      priceEmployerPayroll({
        tenant: B,
        fundingCurrency: "USD",
        lines: [line(foreign, "100")],
        contractors: index([foreign]),
        compartment: wallet(B, "1000"),
        rates,
        fees: DEFAULT_FEES,
      }),
    ).toThrow(/submitted under/);
  });

  it("refuses to guess an unknown SWIFT fee", () => {
    const aud = contractor("au", B, { payoutCurrency: "AUD", method: "SWIFT" });
    expect(() =>
      priceEmployerPayroll({
        tenant: B,
        fundingCurrency: "USD",
        lines: [line(aud, "100")],
        contractors: index([aud]),
        compartment: wallet(B, "1000"),
        rates,
        fees: DEFAULT_FEES,
      }),
    ).toThrow(/refusing to guess/);
  });
});

describe("planWithinCompartment", () => {
  it("pays the highest-priority contractor that fits and holds the rest", () => {
    const plan = planWithinCompartment({
      tenant: B,
      fundingCurrency: "USD",
      lines,
      contractors,
      compartment: wallet(B, "6000"),
      rates,
      fees: DEFAULT_FEES,
    });
    expect(plan.paid).toEqual([priya.id]);
    expect(plan.held).toEqual([jonas.id]);
    expect(plan.quote?.fundable).toBe(true);
  });

  it("holds everyone when nothing fits", () => {
    const plan = planWithinCompartment({
      tenant: B,
      fundingCurrency: "USD",
      lines,
      contractors,
      compartment: wallet(B, "50"),
      rates,
      fees: DEFAULT_FEES,
    });
    expect(plan.paid).toEqual([]);
    expect(plan.quote).toBeNull();
  });
});
