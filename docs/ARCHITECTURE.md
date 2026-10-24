# Architecture

## Principles

1. **Isolation is structural, not procedural.** It is enforced by types and constructors, not by remembering to pass a header.
2. **The model advises; code decides.** Every money-moving action is evaluated by a pure policy function.
3. **Everything is provable after the fact.** Ledger, reconciliation, header coverage and a hash chain are computed on every run.
4. **One interface for the sandbox.** The simulator and the real HTTP transport implement the same `Transport` contract.

## Components

```
┌──────────────────────────── apps/web (React) ────────────────────────────┐
│ Landing · Run view · Approvals · Ledger · API trace · Audit · Intake lab │
└───────────────▲───────────────────────────────────────┬──────────────────┘
        SSE snapshots                              REST (operator actions)
┌───────────────┴──────────────── apps/api (Fastify) ───▼──────────────────┐
│ /api/state /api/events /api/runs /api/approvals/:id/decision             │
│ /api/employers/:key/deposit /api/proofs /api/audit /webhooks/airwallex   │
│ Runtime: builds the engine from env; appends audit JSONL                 │
└───────────────┬──────────────────────────────────────────────────────────┘
┌───────────────▼──────────── packages/agent ──────────────────────────────┐
│ Bulkhead engine                                                          │
│   bootstrap(): create→submit→activate 3 connected accounts, GA, deposits │
│   startRun(): one lane per employer, concurrently                         │
│     intake → compartment → price → [fundable | shortfall] → pay → fee     │
│   deposit(), decide(), proofs(), snapshot()                              │
│ Advisor: ClaudeAdvisor | DeterministicAdvisor (same interface)            │
└───────┬──────────────────────────────────────────────┬───────────────────┘
┌───────▼──────── packages/core (pure) ───────┐ ┌──────▼──── packages/airwallex ─────┐
│ money · compartment · pricing · policy      │ │ PlatformClient / TenantClient       │
│ approvals · ledger · audit · transfers      │ │ RecordingTransport → PacedTransport │
└─────────────────────────────────────────────┘ │   → SimulatedAirwallex | HttpTransport │
                                                └────────────────────────────────────┘
```

## A run, step by step

For each employer, concurrently:
1. **Intake.** `advisor.parseSubmission(text, roster)` returns lines, bank-detail changes and notes. Names are matched against that employer's roster only; currency must equal the contract currency. A bank-detail change creates a `beneficiary_change` approval and parks that line.
2. **Compartment.** `TenantClient(acct).balances()` → `Compartment`. If the funding wallet is empty, the lane waits for _its own_ deposit event.
3. **Price.** `priceEmployerPayroll` computes, per payout currency: payouts + SWIFT fees − foreign balance already held = amount to buy; converts at the indicative rate rounding up; adds the platform fee (bps on gross + per-payout); compares to this employer's funding balance.
4. **Fundable →** for each conversion: policy `convert` → lock quote → policy `rate_check` → convert with a deterministic `request_id` → re-read balances to confirm it landed on this account. Then per line: validate + create beneficiary → policy `payout` (duplicate lock) → `createTransferOnce` → simulate SENT → PAID/FAILED → poll to final status.
5. **Short →** `planWithinCompartment` rations by priority inside the compartment; four options are built and judged; the advisor recommends; payable lines are paid; a bridge approval is requested. The lane then waits for whichever comes first: the decision or the employer's own deposit.
6. **Fee.** After every line is paid, held or returned: policy `charge_fee` → `charges/create` → poll until SETTLED.
7. **Proofs** (when all lanes finish): ledger isolation, header coverage from the recorder, reconciliation (opening balance + ledger net = Airwallex balance for every employer and currency), duplicate-payout check, audit chain verification.

## Why the engine is not a free-running LLM loop

Payroll repeats weekly and most of it should come out the same way every time. The guide is explicit: _"If the agent should make the same choice every time, write the rule in code."_ The model is used where judgement actually varies: unstructured messages, weighing options against an employer's notes, and explaining failures to people. That keeps the cost per run small, the behaviour reproducible, and the failure mode safe: a bad model answer degrades to the rule-based recommendation, never to a wrong payment.

## State and persistence

- The engine keeps run state in memory and publishes full snapshots (debounced 40 ms) to SSE subscribers.
- The audit chain is appended to `BULKHEAD_DATA_DIR/audit-YYYY-MM-DD.jsonl` as it grows. Each record contains `prevHash` and `hash`, so the file can be verified independently.
- Production would add a durable store for runs, request ids and approvals (Postgres with a unique index on `request_id`). See ADR 0003.

## Extending

- **New action the agent can take:** add a `PolicyAction` variant, rules and tests in `core/policy.ts`, then call `evaluate()` before executing it in the engine.
- **New corridor:** add the beneficiary fields to `beneficiaryPayload` (engine) and the validation in the simulator; check `POST /beneficiaries/schema` in the real sandbox first.
- **New advisor:** implement `Advisor`; keep outputs validated and keep a fallback.
