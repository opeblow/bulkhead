# Setup

Three ways to run Bulkhead, from zero-config to the real Airwallex sandbox.

## Requirements

| Tool    | Version                               | Notes                                                           |
| ------- | ------------------------------------- | --------------------------------------------------------------- |
| Node.js | 22.13+ (24 recommended, see `.nvmrc`) | Bulkhead uses only built-in `node:crypto`; no native modules    |
| pnpm    | 10+                                   | `corepack enable` installs the version pinned in `package.json` |
| Docker  | optional                              | for the container route                                         |

## 1. Local, offline (default)

```bash
git clone <this repo> bulkhead && cd bulkhead
corepack enable
pnpm install
pnpm --filter @bulkhead/web build   # builds the console into apps/web/dist
pnpm start                          # API + console on http://127.0.0.1:8787
```

Open **http://127.0.0.1:8787/console** and press **Start payroll run**. The simulator onboards three employer connected accounts at startup, so the run is ready immediately.

### Development mode (hot reload)

```bash
pnpm dev      # API on :8787 (tsx watch) and Vite on :5173 with /api proxied
```

Open http://localhost:5173/console.

### Terminal only

```bash
pnpm demo                 # whole scenario, auto-approving, ends in a proof report
pnpm demo -- --bank-return   # also simulate Lena's bank returning her payout
```

## 2. Docker

```bash
docker compose up --build
# or
docker build -t bulkhead . && docker run -p 8787:8787 bulkhead
```

The image serves the API and the built console from one process, runs as the unprivileged `node` user, and exposes a `/readyz` health check.

## 3. Claude advisor

```bash
cp .env.example .env
# set ANTHROPIC_API_KEY=sk-ant-...
pnpm start
```

The sidebar switches from _Rule-based advisor_ to _Claude · claude-opus-5-5_. Claude is used for three things only: reading submissions, recommending a shortfall option among the ones policy allows, and explaining returned payouts. Responses are JSON-schema constrained and validated with zod; any failure falls back to the rule-based advisor for that one call.

Try the **Intake lab** page with your own messy payroll message.

## 4. Real Airwallex sandbox

Track 6 needs **connected accounts** and **platform payments** enabled on your sandbox account. Airwallex does not switch these on by default.
1. Sign up at [sandbox.airwallex.com](https://sandbox.airwallex.com). If you add a business, name it `New Business Sandbox` or `Sandbox Business` so it is auto-approved.
2. **Account → Developer → API keys**: create a Client ID and API key. Scope it to what the agent needs.
3. Email `devhelp@airwallex.com` with your sandbox email and Client ID, asking for **connected accounts and platform payments** (both are needed for `connected_account_transfers/create` and `charges/create`).
4. Configure:

   ```bash
   AIRWALLEX_MODE=sandbox
   AIRWALLEX_CLIENT_ID=...
   AIRWALLEX_API_KEY=...
   # optional: reuse three already-active employer accounts (A,B,C)
   AIRWALLEX_EMPLOYER_ACCOUNT_IDS=acct_...,acct_...,acct_...
   ```

5. Smoke-test the whole scenario against the sandbox:

   ```bash
   pnpm --filter @bulkhead/api exec tsx src/sandbox-smoke.ts
   ```

   or run the **Airwallex sandbox smoke test** workflow in GitHub Actions with the same values as repository secrets.

Notes from the builder guide that Bulkhead already handles:
- Newly activated accounts can return `unconfigured_client_fee` on FX for a few minutes; Bulkhead waits and retries.
- Accounts must include an EIN in `business_identifiers` **before submit**, or on-behalf transfers fail with `001`/`048`. Bulkhead's onboarding includes one. Accounts created without it cannot be fixed; create new ones.
- Sandbox rate limits are 20 rps global, 10 per endpoint, 10 concurrent. The HTTP transport paces below that.

### Webhooks

Create a subscription in the sandbox web app (**Settings → Developer → Webhooks**), tunnel your local port (for example `cloudflared tunnel --url http://127.0.0.1:8787`), point it at `/webhooks/airwallex`, and set `AIRWALLEX_WEBHOOK_SECRET`. Bulkhead verifies `x-signature` = HMAC-SHA256(`x-timestamp` + raw body), dedupes on event id, and returns 200 quickly.

## Configuration reference

| Variable                                    | Default                             | Meaning                                                                     |
| ------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------- |
| `PORT` / `HOST`                             | `8787` / `127.0.0.1`                | Listen address. Use `HOST=0.0.0.0` in containers                            |
| `AIRWALLEX_MODE`                            | `simulator`                         | `simulator` or `sandbox`                                                    |
| `AIRWALLEX_BASE_URL`                        | `https://api.sandbox.airwallex.com` | REST base                                                                   |
| `AIRWALLEX_CLIENT_ID` / `AIRWALLEX_API_KEY` |                                     | Sandbox credentials                                                         |
| `AIRWALLEX_EMPLOYER_ACCOUNT_IDS`            |                                     | Reuse existing connected accounts (A,B,C)                                   |
| `AIRWALLEX_WEBHOOK_SECRET`                  |                                     | Enables the webhook endpoint                                                |
| `ANTHROPIC_API_KEY`                         |                                     | Enables the Claude advisor                                                  |
| `BULKHEAD_MODEL`                            | `claude-opus-5-5`                   | Claude model id                                                             |
| `BULKHEAD_PACE`                             | `650`                               | Milliseconds between visible steps in the console (0 = as fast as possible) |
| `BULKHEAD_OPERATOR_TOKEN`                   |                                     | If set, every mutating console call must send `x-bulkhead-operator`         |
| `BULKHEAD_DATA_DIR`                         | `./data`                            | Where the audit chain is appended as JSONL                                  |

## Troubleshooting

| Symptom                                          | Cause / fix                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `Bootstrap failed: … auth_failed`                | Wrong Client ID / API key, or the key lacks scopes                                          |
| `forbidden` on FX                                | Account not ACTIVE yet                                                                      |
| `unconfigured_client_fee`                        | Wait a few minutes after activation (Bulkhead retries automatically)                        |
| `001 payer is required` on transfers             | Account was submitted without an EIN; create a new one                                      |
| Console says _Reconnecting_                      | API not running, or a proxy is buffering Server-Sent Events; Bulkhead falls back to polling |
| Native binary errors on `pnpm install` (Windows) | Re-run `pnpm install`; slow networks sometimes drop optional platform binaries              |
