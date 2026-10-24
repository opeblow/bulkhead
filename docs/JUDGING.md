# Notes for judges

**Track:** 6 · Multi-Employer Payroll Executor · Multi-Tenant Platforms

## Five-minute evaluation

```bash
pnpm install && pnpm --filter @bulkhead/web build && pnpm start
# open http://127.0.0.1:8787/console → Start payroll run → approve the two cards
pnpm demo     # or: the same scenario in the terminal, ending in a proof report
pnpm test     # 63 tests: money, policy, pricing, simulator quirks, engine end to end, HTTP API
```

## What to look for

1. **The trap is handled.** During the run, Kestrel's deposit lands and the timeline records Fjord & Pine being re-read on its own as _(unchanged)_. The decision panel shows borrowing from Northwind as **Denied by policy**.
2. **Fees before FX.** Northwind and Fjord & Pine convert €4,012.85 for a €4,000 SWIFT payout.
3. **People where it matters.** The bridge and Tom's bank-detail change both wait for a person; each approval card shows its SHA-256 binding.
4. **Proof, not claims.** The proof bar (and `GET /api/proofs`) reports isolation, header coverage, duplicate payouts, reconciliation and the audit chain.
5. **Honest AI.** The sidebar shows whether Claude or the rule-based advisor is active. The model never computes money and never holds credentials.

## Where to read the code first

1. `packages/core/src/policy.ts`, the rules
2. `packages/core/src/pricing.ts`, fees before FX and rationing inside one compartment
3. `packages/airwallex/src/clients.ts`, `TenantClient`
4. `packages/agent/src/engine.ts` › `handleShortfall`

## Honest limits

Default mode is a simulator built from the builder guide's documented behaviour. The real HTTP transport is implemented and has a manual workflow (`sandbox-smoke.yml`), but the live run depends on Airwallex enabling platform access on the team's sandbox account.
