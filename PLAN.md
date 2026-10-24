# Plan

Bulkhead's plan for the Airwallex Agentic Banking Hackathon (build period 27 Oct – 13 Nov 2026, finalists 15 Nov, Demo Day 19 Nov, San Francisco or remote).

## Goal

Win Track 6 by being the entry a fintech judge trusts with real payroll: correct under the brief's trap, honest about what the model does, and provable after every run.

## What judges will look for (from the brief and the guide)

The builder guide's _Build around a financial decision_ section reads like a rubric. Bulkhead maps to it line by line:

| Guide asks for                                                                           | Bulkhead                                                                                                          |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| A decision that changes when balance, deadline, evidence or risk changes                 | Shortfall options re-priced from the employer's own compartment; mid-run deposit; bank-detail change; bank return |
| Show goal → initial plan → new information → revised decision → resulting balance/status | Console timeline + decision panel + proof bar; `docs/DEMO.md` follows exactly this arc                            |
| Amounts, limits, reserves, validation, duplicate protection, state transitions in code   | `packages/core` (pure, 91% covered)                                                                               |
| Model reads text, compares evidence, proposes, explains exceptions                       | `ClaudeAdvisor`: intake, shortfall recommendation, return explanation                                             |
| Typed tools, not unrestricted credentials                                                | The model never sees keys or calls Airwallex; it returns schema-validated JSON                                    |
| Bind each approval to amount, currency, counterparty, terms, evidence                    | `ApprovalSubject` + SHA-256 digest + `checkBinding()`                                                             |
| Sandbox-only calls behind one interface                                                  | `Transport` interface: `SimulatedAirwallex` and `HttpTransport` are swappable                                     |
| Finish with a financial action or escalation                                             | Bridge transfer, payouts, fee charge, or a held line with the exact top-up requested                              |

## Status

| Milestone                                                                                                           | State                                                                         |
| ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Domain core: money, compartments, pricing, policy, approvals, ledger, audit                                         | Done, tested                                                                  |
| Airwallex client + simulator covering every Track 6 watch-out                                                       | Done, tested                                                                  |
| Run engine: three concurrent lanes, shortfall handling, bridge, bank-change gate, bank return                       | Done, end-to-end tests                                                        |
| Claude advisor with structured output + rule-based fallback                                                         | Done (needs `ANTHROPIC_API_KEY` to exercise live)                             |
| Console: run view, approvals, ledger, API trace, audit chain, intake lab                                            | Done, Playwright e2e                                                          |
| Landing page                                                                                                        | Done                                                                          |
| CI: lint, typecheck, tests (Linux + Windows, Node 22/24), e2e, Docker smoke, CodeQL, dependency review, secret scan | Done, workflows written                                                       |
| Product launch film                                                                                                 | Done, 2:54 film (kept out of the repo; shared as a video link)                |
| Live run against the Airwallex sandbox with platform access                                                         | Pending, blocked on Airwallex enabling connected accounts + platform payments |

## Next, in order

1. **Request platform access** (`devhelp@airwallex.com`) on day one of the build period. It is the critical path: Airwallex says to allow time for a reply.
2. **Run `sandbox-smoke`** against the real sandbox. Record any field-level differences from the simulator in `docs/airwallex-integration.md` and fix the simulator to match.
3. **Record a second demo cut on the live sandbox** so the video shows real `acct_` ids and real API latencies.
4. **Use Claude live** in the recording (set `ANTHROPIC_API_KEY`) so the decision rationale is model-written on camera.
5. **Real webhooks**: subscribe `payout.transfer.*`, tunnel, and show dedupe on a duplicate delivery.
6. Stretch: a `platform_reports/create` export for the operator's month-end; per-employer payroll calendars; partial-day cut-offs.

## Risks

| Risk                                      | Mitigation                                                                                         |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Platform access not granted in time       | Simulator mirrors documented behaviour; README states plainly what was and wasn't run live         |
| Sandbox field names differ from the guide | One transport interface, typed payload builders in one file (`beneficiaryPayload`), smoke workflow |
| Rate limits during a live demo            | Client-side pacing below the documented limits, 429 backoff                                        |
| Model output wrong or refused             | Schema validation, allowed-option check, rule-based fallback, `fallbacks: "default"`               |
| Newly activated accounts fail FX          | Retry through `unconfigured_client_fee`; activate accounts before demo day                         |

## Submission checklist (due 13 Nov 2026)

- [ ] Public repository with this README and `SETUP.md` (HackerEarth requires open source code)
- [ ] Working demo: hosted container or recorded live run
- [ ] Video walkthrough **under five minutes** (the launch film is 2:54; add a 1–2 minute live-sandbox cut if access arrives)
- [ ] Zip of the source uploaded on HackerEarth with run instructions
- [ ] Team details and track selection (Track 6) on the submission form
