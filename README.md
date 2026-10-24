<div align="center">

<img src="docs/assets/mark.svg" width="56" alt="" />

# Bulkhead

**Payroll for many employers. Money that never mixes.**

An agent that runs weekly contractor payroll across Airwallex connected accounts.<br />
It prices, converts and pays each employer only from that employer's wallet. When an employer is short,<br />
it decides what to do instead of borrowing someone else's money.

Airwallex Agentic Banking Hackathon 2026 · **Track 6: Multi-Employer Payroll Executor**

[Quick start](#quick-start) · [How it works](#how-it-works) · [Track 6 checklist](#track-6-checklist) · [Architecture](docs/ARCHITECTURE.md) · [Setup](SETUP.md) · [Demo script](docs/DEMO.md)

</div>

---

## The problem

A payroll platform holds money for many employers. On Airwallex each employer is a **connected account** with its own wallet, and the platform can technically move money between them. That is exactly the danger.

The Track 6 brief sets a trap. Three employers, one run:

|                             |                   Wallet |             This week's payroll |
| --------------------------- | -----------------------: | ------------------------------: |
| **A · Northwind Robotics**  |                  $24,000 |                      $11,980.72 |
| **B · Fjord & Pine Studio** |                   $6,000 | $7,952.83 · **short $1,952.83** |
| **C · Kestrel Health Labs** | $0 → **$15,000 mid-run** |                       $8,280.39 |
| _Sum of all wallets_        |                _$45,000_ |                    _never used_ |

An agent that adds the balances together sees $45,000 and reports the run as covered. Fjord & Pine still cannot pay Jonas. Kestrel's deposit landed in Kestrel's wallet, and it is Kestrel's money.

## What Bulkhead does

1. **Reads** each employer's instructions (a CSV export, an email, a Slack message). Claude extracts the payroll lines and flags anything a person must see, such as a contractor whose bank details just changed.
2. **Seals** each employer in its own _compartment_: balances are read with `x-on-behalf-of: <that employer>` and nothing in the codebase can add compartments together.
3. **Prices** payouts + SWIFT fees + platform fee in exact integer arithmetic, adding the fees _before_ converting.
4. **Decides** when an employer is short. Code lists the options, policy rules on each one, and the advisor recommends among the options it is allowed to pick. Borrowing from another employer is listed and **denied**.
5. **Pays** with stable `request_id`s, follows every transfer to `PAID` or `CANCELLED`, and collects the platform fee only after contractors are paid.
6. **Proves** it: a double-entry ledger, reconciliation against Airwallex balances, a check that every customer call carried `x-on-behalf-of`, and a tamper-evident audit chain.

<p align="center"><img src="docs/assets/console-done.png" alt="Bulkhead console after a completed run: three sealed compartments, the decision panel for Fjord & Pine, and five passing proofs" width="100%" /></p>

## Quick start

```bash
# Node 22.13+ (24 recommended) and pnpm 10+
pnpm install
pnpm --filter @bulkhead/web build
pnpm start                 # → http://127.0.0.1:8787/console
```

With no configuration Bulkhead runs **fully offline**: a high-fidelity Airwallex sandbox simulator plus a rule-based advisor. Add keys to `.env` to go live:

| Variable                                                               | Effect                                                                                  |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`                                                    | Claude (`claude-opus-5-5`) reads submissions, recommends decisions, explains exceptions |
| `AIRWALLEX_MODE=sandbox` + `AIRWALLEX_CLIENT_ID` + `AIRWALLEX_API_KEY` | Real Airwallex sandbox REST API (needs connected accounts + platform payments enabled)  |
| `AIRWALLEX_WEBHOOK_SECRET`                                             | Verifies `POST /webhooks/airwallex`                                                     |

Full instructions, including Docker and the real sandbox: **[SETUP.md](SETUP.md)**.

```bash
pnpm demo        # the whole Track 6 scenario in your terminal, ending in a proof report
pnpm check       # lint + typecheck + 63 tests
pnpm e2e         # Playwright: an operator runs payroll in the browser
```

```text
Proof report
  Tenant isolation       PASS  (19 journals, 0 violations)
  x-on-behalf-of         PASS  (100 customer-scoped calls, 0 missing)
  No duplicate payouts   PASS  (7 payouts, 7 unique request ids)
  Reconciliation         PASS  (8 wallet balances match the ledger)
  Audit chain            PASS  (55 records, head 7a40ec3adf61…)
```

## How it works

```
 employer messages ──► Advisor (Claude | rules) ──► payroll lines, flags
                                                         │
                     ┌───────────── one sealed pipeline per employer ─────────────┐
                     │ TenantClient(acct_X)  ──►  Compartment(acct_X)              │
                     │        │                       │                           │
                     │        ▼                       ▼                           │
                     │   Airwallex API  ◄──  pricing (bigint)  ──►  policy.evaluate │
                     │   x-on-behalf-of        fees before FX        allow/approve/deny
                     └─────────────────────────────────────────────────────────────┘
                                                         │
                          ledger · reconciliation · header coverage · audit chain
```

**The model reads and recommends. Code moves the money.** This follows Airwallex's builder guidance:

> Keep amounts, limits, reserves, validation, duplicate protection, and state transitions in code. Use the model to read unstructured text, compare evidence, propose a plan, and explain an exception.

| Concern                                                                 | Where it lives                                                                 |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Money arithmetic (bigint minor units, round-up on conversion)           | [`packages/core/src/money.ts`](packages/core/src/money.ts)                     |
| Compartments and the breach check                                       | [`packages/core/src/compartment.ts`](packages/core/src/compartment.ts)         |
| Payroll pricing, fees before FX, rationing inside a compartment         | [`packages/core/src/pricing.ts`](packages/core/src/pricing.ts)                 |
| Policy engine (isolation, bridge caps, fraud review, FX drift…)         | [`packages/core/src/policy.ts`](packages/core/src/policy.ts)                   |
| Approvals bound by SHA-256 to exact terms                               | [`packages/core/src/approvals.ts`](packages/core/src/approvals.ts)             |
| Ledger with per-entry isolation check                                   | [`packages/core/src/ledger.ts`](packages/core/src/ledger.ts)                   |
| Typed Airwallex client; `TenantClient` always sends `x-on-behalf-of`    | [`packages/airwallex/src/clients.ts`](packages/airwallex/src/clients.ts)       |
| Sandbox simulator reproducing documented quirks                         | [`packages/airwallex/src/simulator.ts`](packages/airwallex/src/simulator.ts)   |
| Run engine (per-employer lanes, shortfall handling, proofs)             | [`packages/agent/src/engine.ts`](packages/agent/src/engine.ts)                 |
| Claude advisor (structured output, schema-checked, falls back to rules) | [`packages/agent/src/advisor/claude.ts`](packages/agent/src/advisor/claude.ts) |

### The decision, in detail

When Fjord & Pine is short, code produces four options and policy rules on each one _before_ the advisor sees them:

| Option                                                                                                                                          | Policy                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Pay Priya now from Fjord & Pine's funds; bridge **$1,953** of _platform_ capital so Jonas is paid today; repay from Fjord & Pine's next deposit | **Needs a person** · per-employer cap · reserve floor |
| Pay Priya now; hold Jonas until Fjord & Pine tops up                                                                                            | Allowed                                               |
| Hold everyone                                                                                                                                   | Allowed                                               |
| Cover the gap from Northwind's balance                                                                                                          | **Denied** · `TENANT_ISOLATION`                       |

The advisor recommends one of the allowed options, writes the reason for the operator, and drafts a message to the employer. If it proposes a denied option, or returns anything that fails the schema, Bulkhead falls back to the rule-based advisor. The approval card shows a SHA-256 digest of amount, currency, counterparty, terms and evidence; if any of these change before execution, the approval no longer applies and Bulkhead asks again.

## Track 6 checklist

Every warning in the [Airwallex builder guide](https://airwallexdev.com/guide#6-multi-employer-payroll-executor) for this track, and where Bulkhead handles it:

| Brief says                                                                  | Bulkhead                                                                               | Test                                                    |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Don't use one employer's funds for another, even though the platform can    | Compartments + `TENANT_ISOLATION` deny + ledger rejects any two-employer entry         | `policy.test.ts`, `integrity.test.ts`, `engine.test.ts` |
| If the agent sums balances it reports enough money for a batch B can't fund | Pricing asserts it was handed the employer's own compartment; no API sums compartments | `pricing.test.ts` › _CompartmentBreachError_            |
| Calculate SWIFT fees before converting                                      | Fees are part of `toBuy`; policy denies conversions that leave the batch short         | `pricing.test.ts`, `policy.test.ts`                     |
| Set the transfer method explicitly                                          | `Contractor.method` is required; never inferred from fees                              | `pricing.test.ts`                                       |
| Send `x-on-behalf-of` on every employer FX / simulation call                | `TenantClient` cannot be built without an `acct_`; recorder proves coverage            | `simulator.test.ts`, run proofs                         |
| Confirm the conversion landed in the connected account                      | Balances re-read on the employer after every conversion                                | engine timeline `fx.converted`                          |
| Transfers stay PROCESSING until simulated                                   | Each payout moved to SENT → PAID / FAILED and polled to a final status                 | `simulator.test.ts`                                     |
| A failed transfer ends in CANCELLED                                         | `CANCELLED` + `failure_type` handled as a return; no automatic resend                  | `engine.test.ts` › _bank return_                        |
| Activate accounts before FX; `unconfigured_client_fee` window               | Create → submit → activate; FX retries through that window                             | `simulator.test.ts`                                     |
| `request_id` reuse → `duplicate_request_id`; transfers need 10–50 chars     | Deterministic 40-char ids per operation; unclear errors looked up before retry         | `simulator.test.ts` › _recovers a transfer_             |
| Charges return NEW                                                          | Polled until SETTLED; fee collected after contractors                                  | `simulator.test.ts`                                     |
| Three different insufficient-funds codes                                    | All three recognised                                                                   | `integrity.test.ts`                                     |
| EIN required for on-behalf transfers                                        | Included at account creation                                                           | `simulator.test.ts`                                     |
| Webhooks: HMAC over timestamp + raw body, duplicates, out of order          | Raw-body verification, dedupe on event id, sort by `created_at`                        | `server.test.ts`                                        |
| Sandbox rate limits                                                         | Client-side pacing below 10 rps per endpoint; 429 backoff                              | `limiter.ts`, `paced.ts`                                |

## Repository

```
apps/
  api/            Fastify server: REST + Server-Sent Events, webhooks, serves the console
  web/            React console + landing page (Vite)
packages/
  core/           Money, compartments, pricing, policy, approvals, ledger, audit (no I/O)
  airwallex/      Typed client, HTTP transport, simulator, webhook verification
  agent/          Run engine, advisors (Claude / rule-based), demo scenario
docs/             Architecture, integration notes, threat model, ADRs, judging notes
```

## Honest limits

- **The simulator is the default.** It reproduces the sandbox behaviour documented in the builder guide (listed in [`docs/airwallex-integration.md`](docs/airwallex-integration.md)). The HTTP transport implements the same calls against `api.sandbox.airwallex.com`, but this repository has not yet been run against a live sandbox account with platform access enabled. Run the `sandbox-smoke` workflow once access is granted.
- Without `ANTHROPIC_API_KEY` the advisor is rule-based. The console says which one is active.
- Synthetic people and accounts only. Sandbox only. No real money moves.

## Documentation

[SETUP.md](SETUP.md) · [PLAN.md](PLAN.md) · [AGENTS.md](AGENTS.md) · [Architecture](docs/ARCHITECTURE.md) · [Airwallex integration](docs/airwallex-integration.md) · [Threat model](docs/THREAT_MODEL.md) · [Demo script](docs/DEMO.md) · [Judging notes](docs/JUDGING.md) · [ADRs](docs/adr) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Privacy](PRIVACY.md) · [Code of conduct](CODE_OF_CONDUCT.md) · [Changelog](CHANGELOG.md)

## License

[Apache-2.0](LICENSE). Airwallex is a trademark of Airwallex US, LLC. This project is not affiliated with or endorsed by Airwallex.
