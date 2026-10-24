import { SimulatedAirwallex } from "@bulkhead/airwallex";
import { describe, expect, it } from "vitest";
import { DeterministicAdvisor } from "../src/advisor/deterministic.js";
import { Bulkhead } from "../src/engine.js";
import type { Snapshot } from "../src/state.js";

function makeEngine() {
  const sim = new SimulatedAirwallex({ perEndpointRps: 10_000 });
  const engine = new Bulkhead({
    transport: sim,
    simulator: sim,
    advisor: new DeterministicAdvisor(),
    pace: 0,
  });
  return { sim, engine };
}

async function until(engine: Bulkhead, pred: (s: Snapshot) => boolean, ms = 5000): Promise<Snapshot> {
  const start = Date.now();
  for (;;) {
    const s = engine.snapshot();
    if (pred(s)) return s;
    if (Date.now() - start > ms)
      throw new Error(`Timed out. Timeline:\n${s.timeline.map((t) => `${t.kind}: ${t.title}`).join("\n")}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const lane = (s: Snapshot, key: string) => s.run!.lanes.find((l) => l.key === key)!;

describe("Track 6 end-to-end (simulator)", () => {
  it("pays A, isolates B's shortfall from C's mid-run deposit, bridges B on approval, gates Tom's bank change", async () => {
    const { engine, sim } = makeEngine();
    await engine.bootstrap();
    const B = engine.tenantByKey("B")!;
    const C = engine.tenantByKey("C")!;
    // Deterministic: the test delivers C's mid-run deposit itself once B is waiting.
    await engine.startRun({ scriptedDeposit: false });

    // B is short and asks a person to approve a bridge; C waits for its OWN deposit.
    let s = await until(
      engine,
      (x) => lane(x, "B").status === "awaiting_approval" && x.approvals.length >= 2,
    );
    const bridge = s.approvals.find((a) => a.subject.action === "bridge_advance")!;
    const bank = s.approvals.find((a) => a.subject.action === "beneficiary_change")!;
    expect(bridge.tenantName).toBe("Fjord & Pine");
    expect(lane(s, "B").lines.find((l) => l.name === "Priya Raman")?.status).toBe("paid");
    expect(lane(s, "B").lines.find((l) => l.name === "Jonas Berg")?.status).toBe("held");

    // The cross-tenant option was considered and denied by policy.
    const borrow = lane(s, "B").shortfall!.options.find((o) => o.id === "borrow_from_other_employer")!;
    expect(borrow.policy).toBe("deny");

    // C's deposit lands mid-run. B's compartment must be unchanged.
    await until(engine, (x) => lane(x, "C").status === "awaiting_funds");
    await engine.deposit(C, "15000", "Treasury wire");
    s = await until(engine, (x) => x.timeline.some((t) => t.kind === "isolation.recheck"));
    expect(s.timeline.find((t) => t.kind === "isolation.recheck")?.title).toContain("(unchanged)");
    const bUsdBefore = sim.peekBalance(B, "USD");
    expect(Number(sim.peekBalance(C, "USD"))).toBeGreaterThan(0);
    expect(lane(s, "B").status).toBe("awaiting_approval");

    await engine.decide(bank.id, "approve", "test-operator");
    await engine.decide(bridge.id, "approve", "test-operator");
    await engine.waitForRun();
    s = engine.snapshot();

    for (const key of ["A", "B", "C"]) {
      for (const l of lane(s, key).lines) expect(l.status, `${key}/${l.name}`).toBe("paid");
      expect(lane(s, key).fee?.status).toBe("SETTLED");
    }
    expect(Number(bUsdBefore)).toBeLessThan(5000);

    const p = s.proofs!;
    expect(p.isolation.ok).toBe(true);
    expect(p.headerCoverage.ok).toBe(true);
    expect(p.headerCoverage.tenantCalls).toBeGreaterThan(20);
    expect(p.reconciliation.ok).toBe(true);
    expect(p.auditChain.ok).toBe(true);
    expect(p.duplicatePayouts.ok).toBe(true);
    expect(p.duplicatePayouts.payouts).toBe(7);

    // Bridge outstanding until B's own deposit repays it.
    expect(s.platform.bridgeOutstanding).toHaveLength(1);
    await engine.deposit(B, "3000", "Client invoice cleared");
    expect(engine.snapshot().platform.bridgeOutstanding).toHaveLength(0);
    expect((await engine.proofs()).reconciliation.ok).toBe(true);
  });

  it("holds B's second contractor when the bridge is rejected, and never touches C", async () => {
    const { engine } = makeEngine();
    await engine.bootstrap();
    await engine.startRun({ scriptedDeposit: true });
    const s = await until(engine, (x) => x.approvals.filter((a) => a.status === "pending").length >= 2);
    for (const a of s.approvals) await engine.decide(a.id, "reject", "test-operator");
    await engine.waitForRun();
    const end = engine.snapshot();
    expect(lane(end, "B").lines.find((l) => l.name === "Jonas Berg")?.status).toBe("held");
    expect(lane(end, "C").lines.find((l) => l.name === "Tom Whitaker")?.status).toBe("held");
    expect(lane(end, "C").lines.find((l) => l.name === "Sofia Marquez")?.status).toBe("paid");
    expect(end.proofs!.isolation.ok).toBe(true);
    expect(end.proofs!.reconciliation.ok).toBe(true);
  });

  it("handles a bank return without paying twice", async () => {
    const { engine } = makeEngine();
    await engine.bootstrap();
    await engine.startRun({ scriptedDeposit: true, injectBankReturn: "lena" });
    const s = await until(engine, (x) => x.approvals.filter((a) => a.status === "pending").length >= 2);
    for (const a of s.approvals) await engine.decide(a.id, "approve");
    await engine.waitForRun();
    const end = engine.snapshot();
    const lena = lane(end, "A").lines.find((l) => l.name === "Lena Fischer")!;
    expect(lena.status).toBe("failed");
    expect(lena.failure?.type).toBe("BANK_RETURN");
    expect(end.proofs!.duplicatePayouts.ok).toBe(true);
    expect(end.proofs!.reconciliation.ok).toBe(true);
  });
});
