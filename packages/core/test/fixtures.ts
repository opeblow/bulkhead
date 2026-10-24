import { compartment } from "../src/compartment.js";
import type { Contractor, PayrollLine } from "../src/domain.js";
import { type ContractorId, contractorId, tenantId } from "../src/ids.js";
import { type Currency, parseMoney, parseRate } from "../src/money.js";
import type { FxRate, RateBook } from "../src/pricing.js";

export const A = tenantId("acct_employer_a");
export const B = tenantId("acct_employer_b");

const RATES: Record<string, string> = { "USD/EUR": "0.9200", "USD/GBP": "0.7900" };

export const rates: RateBook = (sell: Currency, buy: Currency): FxRate => {
  const r = RATES[`${sell}/${buy}`];
  if (!r) throw new Error(`no rate ${sell}/${buy}`);
  return { sell, buy, rate: parseRate(r), source: "quote", quoteId: `q_${sell}${buy}` };
};

export function contractor(id: string, tenant = B, over: Partial<Contractor> = {}): Contractor {
  return {
    id: contractorId(id),
    tenant,
    name: id,
    email: `${id}@example.test`,
    role: "Engineer",
    country: "DE",
    payoutCurrency: "EUR",
    method: "SWIFT",
    bank: { accountName: id, bankCountry: "DE", iban: "DE89370400440532013000", swiftCode: "COBADEFFXXX" },
    address: { street: "1 Test St", city: "Berlin", postcode: "10115", countryCode: "DE" },
    priority: 1,
    ...over,
  };
}

export function line(c: Contractor, amount: string): PayrollLine {
  return {
    contractorId: c.id,
    tenant: c.tenant,
    amount: parseMoney(amount, c.payoutCurrency),
    memo: "week 43",
    dueDate: "2026-10-23",
  };
}

export function wallet(tenant = B, usd = "0", extra: [Currency, string][] = []) {
  return compartment(tenant, [
    ["USD", parseMoney(usd, "USD")],
    ...extra.map(([c, a]) => [c, parseMoney(a, c)] as [Currency, ReturnType<typeof parseMoney>]),
  ]);
}

export function index(cs: Contractor[]): Map<ContractorId, Contractor> {
  return new Map(cs.map((c) => [c.id, c]));
}
