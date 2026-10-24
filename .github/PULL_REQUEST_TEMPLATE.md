## What changes

<!-- One or two sentences. Link the issue. -->

## Why

## Money-safety checklist

- [ ] No code path sums balances across employers or funds one employer from another
- [ ] Every customer-scoped Airwallex call goes through `TenantClient` (adds `x-on-behalf-of`)
- [ ] New mutating calls use a stable `operationRequestId(...)`, reused only on retry of the same operation
- [ ] Amounts stay in `Money` (bigint minor units); no floats touch balances
- [ ] Any new action the agent can take is evaluated by `evaluate()` in `packages/core/src/policy.ts`
- [ ] Approvals bind to amount, currency, counterparty, terms and evidence (`ApprovalSubject`)

## Verification

- [ ] `pnpm check` passes locally
- [ ] `pnpm demo` proof report is all PASS
- [ ] UI changes: screenshot attached
