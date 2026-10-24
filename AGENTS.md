# AGENTS.md

Instructions for AI coding agents (Claude Code, Codex, Cursor, Gemini CLI…) working in this repository. Human contributors: see [CONTRIBUTING.md](CONTRIBUTING.md).

## What this is

Bulkhead runs contractor payroll for several employers through Airwallex connected accounts. **The one thing it must never do is let one employer's money fund another employer's payroll.** Every rule below exists to protect that.

## Commands

```bash
pnpm install
pnpm check            # lint + typecheck + unit/API tests — run before you say you're done
pnpm test             # vitest (63 tests)
pnpm demo             # full scenario in the terminal; must end with five PASS lines
pnpm --filter @bulkhead/web build && pnpm e2e   # browser test
pnpm dev              # API :8787 + Vite :5173
```

## Map

| Path                 | Responsibility                                                     | I/O?                                       |
| -------------------- | ------------------------------------------------------------------ | ------------------------------------------ |
| `packages/core`      | Money, compartments, pricing, policy, approvals, ledger, audit     | **None.** Pure functions. Keep it that way |
| `packages/airwallex` | Typed REST client, `HttpTransport`, `SimulatedAirwallex`, webhooks | Network                                    |
| `packages/agent`     | `Bulkhead` engine, advisors, scenario                              | Calls the client                           |
| `apps/api`           | Fastify routes, SSE, runtime wiring                                | HTTP                                       |
| `apps/web`           | React console + landing page                                       | Browser                                    |

## Invariants (do not break)

1. **No cross-tenant aggregation.** Never write code that adds balances of different employers to make a funding decision. The only aggregate is `Snapshot.naiveAggregate`, which is display-only and labelled as such.
2. **Customer-scoped calls go through `TenantClient`.** Do not call `transport.send` with a hand-written `onBehalfOf` for customer money. `PlatformClient` deliberately has no wallet methods for customers.
3. **Money is `Money`.** bigint minor units. Never `Number` arithmetic on amounts. Convert at the API edge only, with `toMajor` / `parseMoney`. Conversions round **up** (`sellNeededFor`).
4. **Fees before FX.** `priceEmployerPayroll` includes SWIFT fees in `toBuy`. Don't size a conversion from payouts alone.
5. **Every money-moving action passes `evaluate()`** in `packages/core/src/policy.ts`. Adding a new action means adding a `PolicyAction` variant and tests.
6. **Idempotency.** Mutating calls use `operationRequestId(namespace, ...stableParts)`. Same operation → same id; new operation → new id. Never `newRequestId()` inside a retry loop.
7. **Ambiguous ≠ failed.** On an unclear transfer error, look up by `request_id` before retrying (`TenantClient.createTransferOnce`).
8. **Final statuses only.** Transfers: `PAID` or `CANCELLED` (CANCELLED is the failure state). Charges / platform transfers: only `SETTLED` is final; `NEW` is not.
9. **Approvals bind to terms.** Use `requestApproval(subject)` + `checkBinding()` immediately before executing. Changing amount, counterparty, terms or evidence must make an approval stale.
10. **The model never computes money.** Advisors receive numbers already formatted by code and choose among options policy has judged. Validate every model output (zod) and fall back to `DeterministicAdvisor`.

## Airwallex specifics worth knowing

Read [`docs/airwallex-integration.md`](docs/airwallex-integration.md) before touching the client. Highlights: amounts are major units; `transfer_currency`/`transfer_amount` (not `payment_*`); `transfer_methods` (not `payment_methods`); routing type `sort_code` lowercase; `bank_account_category` exactly `Checking`/`Savings`; account addresses use `address_line1`/`suburb` while beneficiary addresses use `street_address`/`city`.

When changing simulator behaviour, cite the builder-guide line it mirrors in a comment and add a test in `packages/airwallex/test/simulator.test.ts`.

## Style

- TypeScript strict, ESM, `.js` import suffixes inside packages. Biome formats and lints (`pnpm format`).
- Small, named functions; comments explain _why_, not _what_.
- UI: tokens in `apps/web/src/styles.css`. Paper/ink palette with a single signal colour. No gradients-for-decoration, no dark-mode-by-default, no purple.
- Copy in the UI is plain and specific: say what happened and the amount.

## Before you finish

- `pnpm check` is green.
- `pnpm demo` prints five PASS lines.
- If you changed the UI, run the e2e test or attach a screenshot.
- Update `CHANGELOG.md` under _Unreleased_.
