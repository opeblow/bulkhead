import { newRequestId, type TenantId, tenantId } from "@bulkhead/core";
import { beforeEach, describe, expect, it } from "vitest";
import { PlatformClient } from "../src/clients.js";
import { AirwallexError } from "../src/errors.js";
import { RecordingTransport } from "../src/recorder.js";
import { PLATFORM_ACCOUNT, SimulatedAirwallex } from "../src/simulator.js";
import { EventInbox, signWebhook, verifyWebhook } from "../src/webhooks.js";

const EIN = [{ country_code: "US", number: "12-3456789", type: "EIN" }];

async function employer(platform: PlatformClient, name: string, withEin = true): Promise<TenantId> {
  const a = await platform.createAccount({
    account_details: {
      business_details: { business_name: name, ...(withEin ? { business_identifiers: EIN } : {}) },
    },
  });
  await platform.submitAccount(a.id);
  await platform.simulateActivate(a.id);
  return tenantId(a.id);
}

const deBen = {
  beneficiary: {
    entity_type: "PERSONAL" as const,
    first_name: "Jonas",
    last_name: "Berg",
    bank_details: {
      bank_country_code: "DE",
      account_name: "Jonas Berg",
      account_currency: "EUR",
      iban: "DE89370400440532013000",
      swift_code: "COBADEFFXXX",
    },
    address: { street_address: "Torstraße 1", city: "Berlin", postcode: "10119", country_code: "DE" },
  },
  transfer_methods: ["SWIFT" as const],
};

describe("SimulatedAirwallex", () => {
  let sim: SimulatedAirwallex;
  let rec: RecordingTransport;
  let platform: PlatformClient;

  beforeEach(() => {
    sim = new SimulatedAirwallex();
    rec = new RecordingTransport(sim);
    platform = new PlatformClient(rec);
  });

  it("credits deposits immediately even though the response says PENDING", async () => {
    const b = platform.forTenant(await employer(platform, "B"));
    const ga = await b.createGlobalAccount({
      request_id: newRequestId(),
      country_code: "US",
      required_features: [{ currency: "USD", transfer_method: "LOCAL" }],
    });
    const dep = await b.simulateDeposit({ global_account_id: ga.id, amount: "6000" });
    expect(dep.status).toBe("PENDING");
    expect((await b.balances()).find((x) => x.currency === "USD")?.available_amount).toBe(6000);
  });

  it("acts on the PLATFORM wallet when x-on-behalf-of is missing (the kit-6 footgun)", async () => {
    await employer(platform, "B");
    const raw = await rec.send<{ currency: string; available_amount: number }[]>({
      method: "GET",
      path: "/balances/current",
    });
    expect(raw.find((x) => x.currency === "USD")?.available_amount).toBe(5000); // platform funds
    expect(rec.calls().at(-1)?.scopeOk).toBe(false); // recorder flags it
  });

  it("returns forbidden before activation and unconfigured_client_fee right after", async () => {
    sim = new SimulatedAirwallex({ feeConfigDelayMs: 120_000 });
    platform = new PlatformClient(sim);
    const created = await platform.createAccount({
      account_details: { business_details: { business_name: "X" } },
    });
    const t = platform.forTenant(tenantId(created.id));
    await expect(
      t.createQuote({ sell_currency: "USD", buy_currency: "EUR", buy_amount: "100" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await platform.submitAccount(created.id);
    await platform.simulateActivate(created.id);
    await expect(
      t.createQuote({ sell_currency: "USD", buy_currency: "EUR", buy_amount: "100" }),
    ).rejects.toMatchObject({ code: "unconfigured_client_fee" });
  });

  it("debits the SWIFT fee from the same wallet, keeps on-behalf transfers PROCESSING, and fails into CANCELLED", async () => {
    const b = platform.forTenant(await employer(platform, "B"));
    const ga = await b.createGlobalAccount({
      request_id: newRequestId(),
      country_code: "US",
      required_features: [{ currency: "USD", transfer_method: "LOCAL" }],
    });
    await b.simulateDeposit({ global_account_id: ga.id, amount: "10000" });
    await b.convert({
      request_id: newRequestId(),
      sell_currency: "USD",
      buy_currency: "EUR",
      buy_amount: "4012.85",
    });
    const ben = await b.createBeneficiary(deBen);
    const t = await b.createTransfer({
      request_id: newRequestId(),
      beneficiary_id: ben.id,
      transfer_amount: "4000.00",
      transfer_currency: "EUR",
      source_currency: "EUR",
      transfer_method: "SWIFT",
      reference: "wk43",
      reason: "wages_salary",
    });
    expect(t.status).toBe("PROCESSING");
    expect(t.fee_amount).toBe(12.85);
    expect(sim.peekBalance(b.tenant, "EUR")).toBe("0.00");
    await b.simulateTransfer(t.id, "SENT");
    const failed = await b.simulateTransfer(t.id, "FAILED", "BANK_RETURN");
    expect(failed.status).toBe("CANCELLED");
    expect(failed.failure_type).toBe("BANK_RETURN");
    expect(sim.peekBalance(b.tenant, "EUR")).toBe("4000.00");
  });

  it("uses three different insufficient-funds codes", async () => {
    const b = platform.forTenant(await employer(platform, "B"));
    await expect(
      b.convert({ request_id: newRequestId(), sell_currency: "USD", buy_currency: "EUR", buy_amount: "10" }),
    ).rejects.toMatchObject({ code: "insufficient_funds" });
    const ben = await b.createBeneficiary(deBen);
    await expect(
      b.createTransfer({
        request_id: newRequestId(),
        beneficiary_id: ben.id,
        transfer_amount: "10",
        transfer_currency: "EUR",
        source_currency: "EUR",
        transfer_method: "SWIFT",
        reference: "x",
        reason: "wages_salary",
      }),
    ).rejects.toMatchObject({ code: "balance_insufficient" });
    await expect(
      platform.charge({
        request_id: newRequestId(),
        amount: "25",
        currency: "USD",
        source: b.tenant,
        reason: "professional_business_services",
        reference: "fee",
      }),
    ).rejects.toMatchObject({ code: "insufficient_fund" });
  });

  it("rejects reused and malformed request ids", async () => {
    const b = platform.forTenant(await employer(platform, "B"));
    const rid = newRequestId();
    await b.createGlobalAccount({
      request_id: rid,
      country_code: "US",
      required_features: [{ currency: "USD", transfer_method: "LOCAL" }],
    });
    await expect(
      b.createGlobalAccount({
        request_id: rid,
        country_code: "US",
        required_features: [{ currency: "USD", transfer_method: "LOCAL" }],
      }),
    ).rejects.toMatchObject({ code: "duplicate_request_id" });
    const ben = await b.createBeneficiary(deBen);
    await expect(
      b.createTransfer({
        request_id: "short" as never,
        beneficiary_id: ben.id,
        transfer_amount: "1",
        transfer_currency: "EUR",
        source_currency: "EUR",
        transfer_method: "SWIFT",
        reference: "x",
        reason: "wages_salary",
      }),
    ).rejects.toMatchObject({ code: "018" });
  });

  it("validates beneficiaries like the sandbox (IBAN, casing, field names)", async () => {
    const b = platform.forTenant(await employer(platform, "B"));
    await expect(
      b.validateBeneficiary({
        ...deBen,
        beneficiary: {
          ...deBen.beneficiary,
          bank_details: { ...deBen.beneficiary.bank_details, iban: "DE89370400440532013001" },
        },
      }),
    ).rejects.toMatchObject({ code: "083" });
    const gb = {
      beneficiary: {
        entity_type: "PERSONAL" as const,
        first_name: "Priya",
        last_name: "Raman",
        bank_details: {
          bank_country_code: "GB",
          account_name: "Priya Raman",
          account_currency: "GBP",
          bank_name: "Monzo",
          account_number: "41926819",
          account_routing_type1: "SORT_CODE",
          account_routing_value1: "040004",
        },
        address: { street_address: "1 Old St", city: "London", postcode: "EC1V 9HL", country_code: "GB" },
      },
      transfer_methods: ["LOCAL" as const],
    };
    await expect(b.validateBeneficiary(gb)).rejects.toMatchObject({ code: "011" });
    gb.beneficiary.bank_details.account_routing_type1 = "sort_code";
    await expect(b.validateBeneficiary(gb)).resolves.toEqual({ status: "OK" });
  });

  it("refuses on-behalf transfers for an account submitted without an EIN", async () => {
    const b = platform.forTenant(await employer(platform, "NoEIN", false));
    const ben = await b.createBeneficiary(deBen);
    await expect(
      b.createTransfer({
        request_id: newRequestId(),
        beneficiary_id: ben.id,
        transfer_amount: "1",
        transfer_currency: "EUR",
        source_currency: "EUR",
        transfer_method: "SWIFT",
        reference: "x",
        reason: "wages_salary",
      }),
    ).rejects.toMatchObject({ code: "001" });
  });

  it("returns NEW for charges and settles on a later read", async () => {
    const b = platform.forTenant(await employer(platform, "B"));
    const ga = await b.createGlobalAccount({
      request_id: newRequestId(),
      country_code: "US",
      required_features: [{ currency: "USD", transfer_method: "LOCAL" }],
    });
    await b.simulateDeposit({ global_account_id: ga.id, amount: "100" });
    const c = await platform.charge({
      request_id: newRequestId(),
      amount: "25",
      currency: "USD",
      source: b.tenant,
      reason: "professional_business_services",
      reference: "fee",
    });
    expect(c.status).toBe("NEW");
    expect((await platform.getCharge(c.id)).status).toBe("SETTLED");
    expect(sim.peekBalance(PLATFORM_ACCOUNT, "USD")).toBe("5025.00");
  });

  it("recovers a transfer by request_id instead of paying twice", async () => {
    const b = platform.forTenant(await employer(platform, "B"));
    const ga = await b.createGlobalAccount({
      request_id: newRequestId(),
      country_code: "US",
      required_features: [{ currency: "USD", transfer_method: "LOCAL" }],
    });
    await b.simulateDeposit({ global_account_id: ga.id, amount: "10000" });
    await b.convert({
      request_id: newRequestId(),
      sell_currency: "USD",
      buy_currency: "EUR",
      buy_amount: "5000",
    });
    const ben = await b.createBeneficiary(deBen);
    const body = {
      request_id: newRequestId(),
      beneficiary_id: ben.id,
      transfer_amount: "1000",
      transfer_currency: "EUR",
      source_currency: "EUR",
      transfer_method: "SWIFT" as const,
      reference: "x",
      reason: "wages_salary" as const,
    };
    const first = await b.createTransferOnce(body);
    const retry = await b.createTransferOnce(body);
    expect(retry.recovered).toBe(true);
    expect(retry.transfer.id).toBe(first.transfer.id);
    expect((await b.findTransferByRequestId(body.request_id)).items).toHaveLength(1);
  });

  it("enforces per-endpoint rate limits with 429", async () => {
    const s = new SimulatedAirwallex({ perEndpointRps: 2, now: () => 1_000 });
    await s.send({ method: "GET", path: "/balances/current" });
    await s.send({ method: "GET", path: "/balances/current" });
    await expect(s.send({ method: "GET", path: "/balances/current" })).rejects.toBeInstanceOf(AirwallexError);
  });
});

describe("TenantClient", () => {
  it("cannot be created for a malformed account id", () => {
    expect(() => new PlatformClient(new SimulatedAirwallex()).forTenant(tenantId("not-an-account"))).toThrow(
      /Invalid connected account/,
    );
  });
});

describe("webhooks", () => {
  it("verifies HMAC over timestamp + raw body and rejects tampering", () => {
    const body = JSON.stringify({ id: "evt_1", name: "payout.transfer.paid" });
    const ts = String(Date.now());
    const sig = signWebhook("whsec", ts, body);
    expect(verifyWebhook({ secret: "whsec", timestamp: ts, signature: sig, rawBody: body }).ok).toBe(true);
    expect(verifyWebhook({ secret: "whsec", timestamp: ts, signature: sig, rawBody: `${body} ` }).ok).toBe(
      false,
    );
    expect(verifyWebhook({ secret: "whsec", timestamp: undefined, signature: sig, rawBody: body }).ok).toBe(
      false,
    );
  });

  it("dedupes on event id and sorts by created_at", () => {
    const inbox = new EventInbox();
    expect(inbox.accept({ id: "evt_1" })).toBe(true);
    expect(inbox.accept({ id: "evt_1" })).toBe(false);
    const sorted = EventInbox.sort([
      { created_at: "2026-10-23T10:00:02Z" },
      { created_at: "2026-10-23T10:00:01Z" },
    ]);
    expect(sorted[0]?.created_at).toBe("2026-10-23T10:00:01Z");
  });
});
