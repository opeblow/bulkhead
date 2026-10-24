# Demo script (live, about 3 minutes)

Follows the arc the builder guide asks for: **goal → initial plan → new information → revised decision → resulting balance or status.**

Setup: `pnpm start` (simulator) or the sandbox config; open `/console` at 1440×900. Optionally set `ANTHROPIC_API_KEY` so the reasoning on screen is written by Claude.

| Time | Do                                                                      | Say                                                                                                                                              |
| ---- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0:00 | Landing page, scroll to _The problem_                                   | "Three employers, one payroll run. If you add the balances up you get $45,000, and that's the trap: Fjord & Pine can't pay its own contractors." |
| 0:20 | Open console. Point at A / B / C and the struck-through sum             | "Each employer is a sealed compartment, a separate connected account. That sum at the top is never used."                                        |
| 0:35 | **Start payroll run**                                                   | "Bulkhead reads each employer's instructions: a CSV, an email, a Slack message."                                                                 |
| 0:50 | Kestrel's approval card appears                                         | "Kestrel's message says Tom changed banks. That's how payroll fraud happens, so a person confirms it."                                           |
| 1:05 | Northwind pays out; point at the SWIFT fee line                         | "Northwind is funded. Fees are priced before converting, so Lena's SWIFT payout can't bounce."                                                   |
| 1:20 | Fjord & Pine turns amber; the decision panel appears                    | "Fjord & Pine is $1,952.83 short. Code lists four options. Borrowing from Northwind is shown and denied by policy."                              |
| 1:45 | Kestrel's $15,000 lands; timeline shows "re-read on its own: unchanged" | "New information: Kestrel's deposit lands. Fjord & Pine is re-read on its own. Unchanged. Still short."                                          |
| 2:00 | Approve Tom's bank change, then the $1,953 bridge                       | "The approval is a hash of exactly these terms. Approve. Platform capital, not another employer's money."                                        |
| 2:20 | Lanes go green; proof bar appears                                       | "Seven contractors paid. Isolation, x-on-behalf-of on every call, no duplicates, reconciled, audit chain intact."                                |
| 2:40 | API trace page                                                          | "Every Airwallex call, with the employer it acted for."                                                                                          |
| 2:50 | Back to run; press _$3,000 lands in Fjord & Pine's own wallet_          | "And the bridge is repaid from Fjord & Pine's own deposit."                                                                                      |

Variant: tick **Simulate a bank return for Lena** before starting to show a CANCELLED transfer with `failure_type: BANK_RETURN`, the money back in Northwind's wallet, and the exception explanation with no automatic resend.
