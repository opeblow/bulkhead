import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Advisor, Bulkhead, ClaudeAdvisor, DeterministicAdvisor, type Snapshot } from "@bulkhead/agent";
import { HttpTransport, SimulatedAirwallex, type Transport } from "@bulkhead/airwallex";
import type { Config } from "./config.js";

/**
 * Holds the live engine. Reset (simulator only) swaps in a fresh engine while SSE clients
 * stay subscribed to the runtime, not to a particular engine instance.
 */
export class Runtime {
  engine!: Bulkhead;
  private readonly subscribers = new Set<(s: Snapshot) => void>();
  private unsubscribe: (() => void) | null = null;
  private bootPromise: Promise<void> | null = null;
  readonly advisor: Advisor;

  constructor(readonly config: Config) {
    this.advisor = config.anthropicApiKey
      ? new ClaudeAdvisor({ apiKey: config.anthropicApiKey, model: config.model })
      : new DeterministicAdvisor();
    mkdirSync(config.dataDir, { recursive: true });
    this.create();
  }

  private create(): void {
    this.unsubscribe?.();
    let transport: Transport;
    let simulator: SimulatedAirwallex | undefined;
    if (this.config.airwallexMode === "sandbox") {
      transport = new HttpTransport({
        baseUrl: this.config.airwallexBaseUrl,
        clientId: this.config.airwallexClientId,
        apiKey: this.config.airwallexApiKey,
      });
    } else {
      simulator = new SimulatedAirwallex();
      transport = simulator;
    }
    const auditFile = join(this.config.dataDir, `audit-${new Date().toISOString().slice(0, 10)}.jsonl`);
    this.engine = new Bulkhead({
      transport,
      simulator,
      advisor: this.advisor,
      pace: this.config.pace,
      existingAccounts: this.config.existingAccounts,
      onAudit: (r) => {
        try {
          appendFileSync(auditFile, `${JSON.stringify(r)}\n`);
        } catch {
          // Audit persistence is best effort on read-only filesystems; the in-memory chain stays authoritative.
        }
      },
    });
    this.unsubscribe = this.engine.onChange((s) => {
      for (const fn of this.subscribers) fn(s);
    });
    this.bootPromise = this.engine.bootstrap();
  }

  async ready(): Promise<void> {
    await this.bootPromise;
  }

  async reset(): Promise<void> {
    if (this.config.airwallexMode !== "simulator")
      throw new Error("Reset is only available in simulator mode");
    this.create();
    await this.ready();
    const s = this.engine.snapshot();
    for (const fn of this.subscribers) fn(s);
  }

  subscribe(fn: (s: Snapshot) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }
}
