import { resolve } from "node:path";

export interface Config {
  readonly port: number;
  readonly host: string;
  readonly airwallexMode: "simulator" | "sandbox";
  readonly airwallexBaseUrl: string;
  readonly airwallexClientId: string;
  readonly airwallexApiKey: string;
  readonly webhookSecret: string;
  readonly existingAccounts: string[];
  readonly anthropicApiKey: string;
  readonly model: string;
  readonly dataDir: string;
  readonly operatorToken: string;
  readonly pace: number;
  readonly webDist: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = (env.AIRWALLEX_MODE ?? "simulator").toLowerCase();
  if (mode !== "simulator" && mode !== "sandbox")
    throw new Error(`AIRWALLEX_MODE must be simulator or sandbox, got ${mode}`);
  const cfg: Config = {
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? "127.0.0.1",
    airwallexMode: mode,
    airwallexBaseUrl: env.AIRWALLEX_BASE_URL ?? "https://api.sandbox.airwallex.com",
    airwallexClientId: env.AIRWALLEX_CLIENT_ID ?? "",
    airwallexApiKey: env.AIRWALLEX_API_KEY ?? "",
    webhookSecret: env.AIRWALLEX_WEBHOOK_SECRET ?? "",
    existingAccounts: (env.AIRWALLEX_EMPLOYER_ACCOUNT_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? "",
    model: env.BULKHEAD_MODEL ?? "claude-opus-5-5",
    dataDir: resolve(env.BULKHEAD_DATA_DIR ?? "./data"),
    operatorToken: env.BULKHEAD_OPERATOR_TOKEN ?? "",
    pace: Number(env.BULKHEAD_PACE ?? 650),
    webDist: resolve(
      env.BULKHEAD_WEB_DIST ??
        new URL("../../web/dist", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
    ),
  };
  if (cfg.airwallexMode === "sandbox" && (!cfg.airwallexClientId || !cfg.airwallexApiKey)) {
    throw new Error(
      "AIRWALLEX_MODE=sandbox needs AIRWALLEX_CLIENT_ID and AIRWALLEX_API_KEY (Account > Developer > API keys)",
    );
  }
  return cfg;
}
