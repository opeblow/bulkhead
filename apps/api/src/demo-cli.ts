/**
 * Headless demo: `pnpm demo`. Runs the full Track 6 scenario in the terminal, approving
 * the requested actions automatically, then prints the proof report.
 */
import { Bulkhead, ClaudeAdvisor, DeterministicAdvisor } from "@bulkhead/agent";
import { SimulatedAirwallex } from "@bulkhead/airwallex";

const sim = new SimulatedAirwallex();
const advisor = process.env.ANTHROPIC_API_KEY
  ? new ClaudeAdvisor({ model: process.env.BULKHEAD_MODEL })
  : new DeterministicAdvisor();
const engine = new Bulkhead({
  transport: sim,
  simulator: sim,
  advisor,
  pace: Number(process.env.BULKHEAD_PACE ?? 120),
});

const TONE: Record<string, string> = {
  good: "\x1b[32m●\x1b[0m",
  bad: "\x1b[31m●\x1b[0m",
  warn: "\x1b[33m●\x1b[0m",
  agent: "\x1b[36m◆\x1b[0m",
  policy: "\x1b[35m■\x1b[0m",
  operator: "\x1b[34m▲\x1b[0m",
  airwallex: "\x1b[90m→\x1b[0m",
  neutral: "·",
};

let printed = 0;
engine.onChange((s) => {
  for (const t of s.timeline.slice(printed)) {
    const who = s.employers.find((e) => e.tenant === t.tenant)?.shortName ?? "platform";
    console.log(`${TONE[t.tone] ?? "·"} ${who.padEnd(15)} ${t.title}`);
    if (t.detail && ["agent", "policy", "bad"].includes(t.tone))
      console.log(`  ${" ".repeat(15)} \x1b[90m${t.detail}\x1b[0m`);
  }
  printed = s.timeline.length;
  for (const a of s.approvals.filter((x) => x.status === "pending")) {
    setTimeout(() => void engine.decide(a.id, "approve", "demo-cli").catch(() => {}), 400);
  }
});

await engine.bootstrap();
await engine.startRun({
  scriptedDeposit: true,
  injectBankReturn: process.argv.includes("--bank-return") ? "lena" : null,
});
await engine.waitForRun();
await new Promise((r) => setTimeout(r, 100));
const p = await engine.proofs();
console.log("\nProof report");
console.log(
  `  Tenant isolation       ${p.isolation.ok ? "PASS" : "FAIL"}  (${p.isolation.journals} journals, ${p.isolation.violations} violations)`,
);
console.log(
  `  x-on-behalf-of         ${p.headerCoverage.ok ? "PASS" : "FAIL"}  (${p.headerCoverage.tenantCalls} customer-scoped calls, ${p.headerCoverage.missing} missing)`,
);
console.log(
  `  No duplicate payouts   ${p.duplicatePayouts.ok ? "PASS" : "FAIL"}  (${p.duplicatePayouts.payouts} payouts, ${p.duplicatePayouts.unique} unique request ids)`,
);
console.log(
  `  Reconciliation         ${p.reconciliation.ok ? "PASS" : "FAIL"}  (${p.reconciliation.rows.length} wallet balances match the ledger)`,
);
console.log(
  `  Audit chain            ${p.auditChain.ok ? "PASS" : "FAIL"}  (${p.auditChain.length} records, head ${p.auditChain.head.slice(0, 12)}…)`,
);
process.exit(p.isolation.ok && p.headerCoverage.ok && p.reconciliation.ok && p.auditChain.ok ? 0 : 1);
