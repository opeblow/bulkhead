import { describe, expect, it } from "vitest";
import {
  add,
  bps,
  convert,
  format,
  parseMoney,
  parseRate,
  sellNeededFor,
  sub,
  toMajor,
} from "../src/money.js";

describe("money", () => {
  it("parses major units exactly, with no float drift", () => {
    expect(parseMoney("7525.70", "EUR").minor).toBe(752570n);
    expect(parseMoney(12.85, "EUR").minor).toBe(1285n);
    expect(parseMoney("0.1", "USD").minor + parseMoney("0.2", "USD").minor).toBe(30n);
    expect(parseMoney("1,250.00", "USD").minor).toBe(125000n);
  });

  it("rejects sub-minor precision instead of silently rounding", () => {
    expect(() => parseMoney("10.005", "USD")).toThrow(/precision/);
    expect(parseMoney("10.500", "USD").minor).toBe(1050n);
  });

  it("round-trips to the major-unit strings Airwallex expects", () => {
    expect(toMajor(parseMoney("100", "USD"))).toBe("100.00");
    expect(toMajor(parseMoney("0.07", "GBP"))).toBe("0.07");
    expect(toMajor(parseMoney("1500", "JPY"))).toBe("1500");
  });

  it("formats for humans", () => {
    expect(format(parseMoney("9000", "USD"))).toBe("$9,000.00");
    expect(format(parseMoney("-12.85", "EUR"))).toBe("−€12.85");
  });

  it("refuses to add different currencies", () => {
    expect(() => add(parseMoney("1", "USD"), parseMoney("1", "EUR"))).toThrow(/mismatch/);
  });

  it("never under-converts: sell amount rounds up", () => {
    const rate = parseRate("0.9235"); // EUR per USD
    const buy = parseMoney("4012.85", "EUR");
    const sell = sellNeededFor(buy, "USD", rate);
    // Buying back with the sell amount must cover the buy amount.
    expect(convert(sell, "EUR", rate, "down").minor).toBeGreaterThanOrEqual(buy.minor);
    // …and one cent less must not.
    expect(convert(sub(sell, parseMoney("0.01", "USD")), "EUR", rate, "down").minor).toBeLessThan(buy.minor);
  });

  it("handles cross-exponent conversion", () => {
    const jpy = convert(parseMoney("10", "USD"), "JPY", parseRate("151.234"), "half-up");
    expect(jpy.minor).toBe(1512n);
  });

  it("computes basis points", () => {
    expect(bps(parseMoney("10000", "USD"), 50).minor).toBe(5000n);
    expect(bps(parseMoney("0.01", "USD"), 50, "up").minor).toBe(1n);
  });
});
