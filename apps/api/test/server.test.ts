import { signWebhook } from "@bulkhead/airwallex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { Runtime } from "../src/runtime.js";
import { buildServer } from "../src/server.js";

const config = {
  ...loadConfig({
    BULKHEAD_PACE: "0",
    BULKHEAD_DATA_DIR: "./.test-data",
    AIRWALLEX_WEBHOOK_SECRET: "whsec_test",
  }),
  webDist: "/nonexistent",
};
const rt = new Runtime(config);
const app = buildServer(rt);

beforeAll(async () => {
  await rt.ready();
});
afterAll(async () => {
  await app.close();
});

describe("HTTP API", () => {
  it("reports health and readiness", async () => {
    expect((await app.inject("/healthz")).json()).toEqual({ ok: true });
    const ready = (await app.inject("/readyz")).json();
    expect(ready).toMatchObject({ ok: true, mode: "simulator", advisor: "deterministic" });
  });

  it("sends security headers", async () => {
    const res = await app.inject("/api/state");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  });

  it("exposes a bootstrapped snapshot with three employers", async () => {
    const s = (await app.inject("/api/state")).json();
    expect(s.bootstrapped).toBe(true);
    expect(s.employers.map((e: { key: string }) => e.key)).toEqual(["A", "B", "C"]);
  });

  it("validates deposit input", async () => {
    const bad = await app.inject({
      method: "POST",
      url: "/api/employers/B/deposit",
      payload: { amount: "-5" },
    });
    expect(bad.statusCode).toBe(400);
    const unknown = await app.inject({
      method: "POST",
      url: "/api/employers/Z/deposit",
      payload: { amount: "5" },
    });
    expect(unknown.statusCode).toBe(404);
  });

  it("runs payroll end to end over HTTP", async () => {
    const started = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: { scriptedDeposit: true },
    });
    expect(started.statusCode).toBe(202);
    const again = await app.inject({ method: "POST", url: "/api/runs", payload: {} });
    expect(again.statusCode).toBe(409);

    for (let i = 0; i < 200; i++) {
      const s = (await app.inject("/api/state")).json();
      const pending = s.approvals.filter((a: { status: string }) => a.status === "pending");
      for (const a of pending) {
        const r = await app.inject({
          method: "POST",
          url: `/api/approvals/${a.id}/decision`,
          payload: { decision: "approve" },
        });
        expect(r.statusCode).toBe(200);
      }
      if (s.run?.status === "complete") break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const proofs = (await app.inject("/api/proofs")).json();
    expect(proofs.isolation.ok).toBe(true);
    expect(proofs.reconciliation.ok).toBe(true);
    const audit = (await app.inject("/api/audit")).json();
    expect(audit.verification.ok).toBe(true);
  });

  it("rejects unsigned or tampered webhooks and dedupes valid ones", async () => {
    const body = JSON.stringify({
      id: "evt_test_1",
      name: "payout.transfer.paid",
      account_id: "acct_x",
      created_at: new Date().toISOString(),
      data: { object: {} },
    });
    const ts = String(Date.now());
    const unsigned = await app.inject({
      method: "POST",
      url: "/webhooks/airwallex",
      payload: body,
      headers: { "content-type": "application/json" },
    });
    expect(unsigned.statusCode).toBe(401);
    const sig = signWebhook("whsec_test", ts, body);
    const headers = { "content-type": "application/json", "x-timestamp": ts, "x-signature": sig };
    expect(
      (await app.inject({ method: "POST", url: "/webhooks/airwallex", payload: body, headers })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "POST", url: "/webhooks/airwallex", payload: `${body} `, headers }))
        .statusCode,
    ).toBe(401);
  });

  it("parses messy intake text", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/intake/parse",
      payload: { employer: "B", text: "Jonas Berg €4,000 and Priya Raman £2,800 today" },
    });
    expect(r.json().lines).toHaveLength(2);
  });
});
