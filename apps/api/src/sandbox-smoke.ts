/**
 * Run the Track 6 scenario against the real Airwallex sandbox and print the proof report.
 * Usage: AIRWALLEX_MODE=sandbox AIRWALLEX_CLIENT_ID=… AIRWALLEX_API_KEY=… pnpm --filter @bulkhead/api exec tsx src/sandbox-smoke.ts
 */
import { Bulkhead, ClaudeAdvisor, DeterministicAdvisor } from "@bulkhead/agent";
import { HttpTransport } from "@bulkhead/airwallex";
import { loadConfig } from "./config.js";

const cfg = loadConfig({ ...process.env, AIRWALLEX_MODE: "sandbox" });
const engine = new Bulkhead({
  transport: new HttpTransport({
    baseUrl: cfg.airwallexBaseUrl,
    clientId: cfg.airwallexClientId,
    apiKey: cfg.airwallexApiKey,
  }),
  advisor: cfg.anthropicApiKey
    ? new ClaudeAdvisor({ apiKey: cfg.anthropicApiKey, model: cfg.model })
    : new DeterministicAdvisor(),
  pace: 0,
  existingAccounts: cfg.existingAccounts,
});

let printed = 0;
engine.onChange((s) => {
  for (const t of s.timeline.slice(printed))
    console.log(`[${t.tone}] ${t.title}${t.detail ? ` — ${t.detail}` : ""}`);
  printed = s.timeline.length;
  for (const a of s.approvals.filter((x) => x.status === "pending")) {
    void engine.decide(a.id, "approve", "sandbox-smoke").catch(() => {});
  }
});

await engine.bootstrap();
const C = engine.tenantByKey("C");
await engine.startRun({ scriptedDeposit: false });
// Deliver Kestrel's treasury wire explicitly once its lane is waiting.
for (let i = 0; i < 120; i++) {
  const lane = engine.snapshot().run?.lanes.find((l) => l.key === "C");
  if (lane?.status === "awaiting_funds" && C) {
    await engine.deposit(C, "15000", "Treasury wire");
    break;
  }
  await new Promise((r) => setTimeout(r, 1000));
}
await engine.waitForRun();
const p = await engine.proofs();
console.log(JSON.stringify(p, null, 2));
process.exit(p.isolation.ok && p.headerCoverage.ok && p.reconciliation.ok && p.auditChain.ok ? 0 : 1);
