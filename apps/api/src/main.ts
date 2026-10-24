import { loadConfig } from "./config.js";
import { Runtime } from "./runtime.js";
import { buildServer } from "./server.js";

const config = loadConfig();
const runtime = new Runtime(config);
const app = buildServer(runtime, { logger: process.env.LOG_LEVEL === "debug" });

await app.listen({ port: config.port, host: config.host });
await runtime.ready().catch((e) => {
  console.error(`Bootstrap failed: ${(e as Error).message}`);
});

const line = "─".repeat(58);
console.log(`\n${line}\n  Bulkhead · every employer is a sealed compartment\n${line}`);
console.log(`  Console    http://${config.host}:${config.port}/console`);
console.log(
  `  Airwallex  ${config.airwallexMode}${config.airwallexMode === "sandbox" ? ` (${config.airwallexBaseUrl})` : " (high-fidelity simulator)"}`,
);
console.log(
  `  Advisor    ${runtime.advisor.kind}${runtime.advisor.model ? ` · ${runtime.advisor.model}` : " (set ANTHROPIC_API_KEY for Claude)"}`,
);
console.log(`${line}\n`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void app.close().then(() => process.exit(0));
  });
}
