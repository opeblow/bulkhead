import type { Address, BankDetails, Contractor, TransferMethod } from "@bulkhead/core";
import { type Currency, contractorId, tenantId } from "@bulkhead/core";

/**
 * The Track 6 demo world. Synthetic people, valid routing identifiers with made-up account
 * numbers (Airwallex validates IBAN checksums, ABA routing and sort codes).
 *
 *  A · Northwind Robotics   funded $24,000   → pays everyone
 *  B · Fjord & Pine Studio  funded  $6,000   → short; must not borrow from C
 *  C · Kestrel Health Labs  funded      $0   → deposit lands mid-run; one bank-detail change
 */

export type SubmissionChannel = "csv" | "email" | "slack";

export interface EmployerSeed {
  readonly key: "A" | "B" | "C";
  readonly legalName: string;
  readonly shortName: string;
  readonly contact: string;
  readonly fundingCurrency: Currency;
  readonly initialDeposit: string | null;
  readonly midRunDeposit: string | null;
  readonly contractors: readonly ContractorSeed[];
  readonly submission: { channel: SubmissionChannel; from: string; receivedAt: string; text: string };
}

export interface ContractorSeed {
  readonly slug: string;
  readonly name: string;
  readonly role: string;
  readonly country: string;
  readonly payoutCurrency: Currency;
  readonly method: TransferMethod;
  readonly priority: number;
  readonly bank: BankDetails;
  readonly address: Address;
}

export const SCENARIO: readonly EmployerSeed[] = [
  {
    key: "A",
    legalName: "Northwind Robotics, Inc.",
    shortName: "Northwind",
    contact: "ops@northwind.example",
    fundingCurrency: "USD",
    initialDeposit: "24000",
    midRunDeposit: null,
    contractors: [
      {
        slug: "amara",
        name: "Amara Okafor",
        role: "Platform engineer",
        country: "GB",
        payoutCurrency: "GBP",
        method: "LOCAL",
        priority: 1,
        bank: {
          accountName: "Amara Okafor",
          bankCountry: "GB",
          bankName: "Barclays",
          accountNumber: "55779911",
          routingType: "sort_code",
          routingValue: "200000",
        },
        address: { street: "14 Brunswick Place", city: "London", postcode: "N1 6EB", countryCode: "GB" },
      },
      {
        slug: "lena",
        name: "Lena Fischer",
        role: "Firmware engineer",
        country: "DE",
        payoutCurrency: "EUR",
        method: "SWIFT",
        priority: 1,
        bank: {
          accountName: "Lena Fischer",
          bankCountry: "DE",
          iban: "DE44500105175407324931",
          swiftCode: "INGDDEFFXXX",
        },
        address: { street: "Schönhauser Allee 36", city: "Berlin", postcode: "10435", countryCode: "DE" },
      },
      {
        slug: "diego",
        name: "Diego Alvarez",
        role: "QA lead",
        country: "US",
        payoutCurrency: "USD",
        method: "LOCAL",
        priority: 2,
        bank: {
          accountName: "Diego Alvarez",
          bankCountry: "US",
          accountNumber: "000123456789",
          routingType: "aba",
          routingValue: "021000021",
          accountCategory: "Checking",
        },
        address: {
          street: "2100 Guadalupe St",
          city: "Austin",
          state: "TX",
          postcode: "78705",
          countryCode: "US",
        },
      },
    ],
    submission: {
      channel: "csv",
      from: "HRIS export · northwind-payroll-wk43.csv",
      receivedAt: "2026-10-23T07:42:00Z",
      text: [
        "contractor,amount,currency,memo",
        "Amara Okafor,3200.00,GBP,Week 43 platform engineering",
        "Lena Fischer,4000.00,EUR,Week 43 firmware",
        "Diego Alvarez,3500.00,USD,Week 43 QA",
      ].join("\n"),
    },
  },
  {
    key: "B",
    legalName: "Fjord & Pine Studio LLC",
    shortName: "Fjord & Pine",
    contact: "ingrid@fjordpine.example",
    fundingCurrency: "USD",
    initialDeposit: "6000",
    midRunDeposit: null,
    contractors: [
      {
        slug: "priya",
        name: "Priya Raman",
        role: "iOS engineer",
        country: "GB",
        payoutCurrency: "GBP",
        method: "LOCAL",
        priority: 1,
        bank: {
          accountName: "Priya Raman",
          bankCountry: "GB",
          bankName: "Monzo",
          accountNumber: "41926819",
          routingType: "sort_code",
          routingValue: "040004",
        },
        address: { street: "3 Hoxton Square", city: "London", postcode: "N1 6NU", countryCode: "GB" },
      },
      {
        slug: "jonas",
        name: "Jonas Berg",
        role: "Design systems",
        country: "DE",
        payoutCurrency: "EUR",
        method: "SWIFT",
        priority: 2,
        bank: {
          accountName: "Jonas Berg",
          bankCountry: "DE",
          iban: "DE89370400440532013000",
          swiftCode: "COBADEFFXXX",
        },
        address: { street: "Torstraße 140", city: "Berlin", postcode: "10119", countryCode: "DE" },
      },
    ],
    submission: {
      channel: "email",
      from: "Ingrid Solberg <ingrid@fjordpine.example>",
      receivedAt: "2026-10-23T07:51:00Z",
      text: [
        "Subject: Payroll this week",
        "",
        "Hi Bulkhead team,",
        "",
        "Please run this week's contractor payroll: Jonas Berg €4,000 for the design system work and Priya Raman £2,800 for iOS. Both are expecting to be paid today.",
        "",
        "We're a little tight until a client invoice clears on Monday, sorry about that.",
        "",
        "Ingrid · Fjord & Pine",
      ].join("\n"),
    },
  },
  {
    key: "C",
    legalName: "Kestrel Health Labs, Inc.",
    shortName: "Kestrel Health",
    contact: "finance@kestrel.example",
    fundingCurrency: "USD",
    initialDeposit: null,
    midRunDeposit: "15000",
    contractors: [
      {
        slug: "sofia",
        name: "Sofia Marquez",
        role: "Data engineer",
        country: "US",
        payoutCurrency: "USD",
        method: "LOCAL",
        priority: 1,
        bank: {
          accountName: "Sofia Marquez",
          bankCountry: "US",
          accountNumber: "000987654321",
          routingType: "aba",
          routingValue: "026009593",
          accountCategory: "Checking",
        },
        address: {
          street: "500 Boylston St",
          city: "Boston",
          state: "MA",
          postcode: "02116",
          countryCode: "US",
        },
      },
      {
        slug: "tom",
        name: "Tom Whitaker",
        role: "Clinical UX",
        country: "GB",
        payoutCurrency: "GBP",
        method: "LOCAL",
        priority: 1,
        bank: {
          accountName: "Tom Whitaker",
          bankCountry: "GB",
          bankName: "HSBC",
          accountNumber: "61234590",
          routingType: "sort_code",
          routingValue: "401276",
        },
        address: { street: "21 Deansgate", city: "Manchester", postcode: "M3 4EW", countryCode: "GB" },
      },
    ],
    submission: {
      channel: "slack",
      from: "#payroll · Marcus Chen (Kestrel finance)",
      receivedAt: "2026-10-23T08:03:00Z",
      text: "@bulkhead payroll for wk 43: Sofia Marquez $5,200, Tom Whitaker £2,400. FYI Tom changed banks, new account: Nationwide, sort code 07-01-16, acct 33012477. Our treasury wire lands this morning.",
    },
  },
];

export function contractorFromSeed(seed: ContractorSeed, tenant: string): Contractor {
  return {
    id: contractorId(`ctr_${seed.slug}`),
    tenant: tenantId(tenant),
    name: seed.name,
    email: `${seed.slug}@contractors.example`,
    role: seed.role,
    country: seed.country,
    payoutCurrency: seed.payoutCurrency,
    method: seed.method,
    bank: seed.bank,
    address: seed.address,
    priority: seed.priority,
  };
}
