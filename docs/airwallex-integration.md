# Airwallex integration notes

Endpoints Bulkhead uses, the behaviour the simulator reproduces, and where each is handled. Sources: the Airwallex [Agentic Banking builder guide](https://airwallexdev.com/guide) (Track 6, _Working with the API_, _Platform setup_, _Sandbox constraints_) and the Airwallex API reference.

> The simulator follows what the guide documents. Re-verify against the live sandbox with `sandbox-smoke` and record differences here.

## Authentication

`POST /api/v1/authentication/login` with `x-client-id` and `x-api-key`, no body → bearer token valid 30 minutes. `HttpTransport` caches it, refreshes 5 minutes early, and dedupes concurrent logins.

## Endpoints

| Step            | Endpoint                                                     | Scope    | Notes handled                                                                                                                                   |
| --------------- | ------------------------------------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Create employer | `POST /accounts/create`                                      | platform | `account_details` required; business person + EIN in the create call (adding later does not persist)                                            |
| Submit          | `POST /accounts/{id}/submit`                                 | platform | empty body                                                                                                                                      |
| Activate        | `POST /simulation/accounts/{id}/update_status`               | platform | `{"next_status":"ACTIVE","force":true}`                                                                                                         |
| Confirm         | `GET /accounts/{id}`                                         | platform | must be ACTIVE before FX                                                                                                                        |
| Global account  | `GET /global_accounts`, `POST /global_accounts/create`       | tenant   | reuse first; `country_code` is the account country; `required_features` are objects                                                             |
| Deposit         | `POST /simulation/deposit/create`                            | tenant   | answers PENDING, balance credited immediately; `currency` in body is ignored                                                                    |
| Balances        | `GET /balances/current`                                      | tenant   | re-read after every deposit and conversion                                                                                                      |
| Beneficiary     | `POST /beneficiaries/validate`, `POST /beneficiaries/create` | tenant   | `transfer_methods` not `payment_methods`; US `aba` + `Checking`/`Savings`; GB `bank_name` + lowercase `sort_code`; DE SWIFT IBAN + `swift_code` |
| FX rate         | `GET /fx/rates/current`                                      | tenant   | indicative `rate`, no `quote_id`                                                                                                                |
| FX quote        | `POST /fx/quotes/create`                                     | tenant   | read `client_rate`                                                                                                                              |
| Conversion      | `POST /fx/conversions/create`                                | tenant   | `x-on-behalf-of` mandatory; no `x-api-version`; SETTLED immediately                                                                             |
| Payout          | `POST /transfers/create`                                     | tenant   | `transfer_currency` / `transfer_amount`; method LOCAL or SWIFT only; 10–50 char `request_id`                                                    |
| Lookup          | `GET /transfers?request_id=` , `GET /transfers/{id}`         | tenant   | used before any retry                                                                                                                           |
| Simulate        | `POST /simulation/transfers/{id}/transition`                 | tenant   | SENT before PAID; `failure_type` applies only after SENT; failures end CANCELLED                                                                |
| Bridge          | `POST /connected_account_transfers/create`                   | platform | `destination` is a plain string; `reference` required; reason `wages_salary`; returns NEW                                                       |
| Fee / repayment | `POST /charges/create`                                       | platform | `source` plain string; `reference` required; reason `professional_business_services` / `repayment`; returns NEW                                 |

## Quirks reproduced by the simulator

| Behaviour                                                                              | Simulator                                                         | Engine response                                                 |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------- |
| Missing `x-on-behalf-of` hits the platform wallet                                      | yes                                                               | impossible through `TenantClient`; recorder flags any such call |
| FX `forbidden` before ACTIVE; `unconfigured_client_fee` after                          | yes (window configurable)                                         | retries for up to ~3 minutes                                    |
| SWIFT flat fee debited from same wallet (EUR 12.85)                                    | yes                                                               | fees priced before FX                                           |
| Three insufficient-funds codes                                                         | `balance_insufficient`, `insufficient_fund`, `insufficient_funds` | all recognised                                                  |
| `duplicate_request_id` on reuse                                                        | yes                                                               | deterministic ids; lookup before retry                          |
| `018` on bad request id length                                                         | yes                                                               | 40-char ids                                                     |
| EIN missing → `001` / `048` on on-behalf transfers                                     | yes                                                               | EIN included at create                                          |
| IBAN checksum `083`; invented routing `010`; `SORT_CODE` → `011`; bad category → `016` | yes                                                               | payload builder uses valid formats                              |
| Rate limits 10 rps per endpoint                                                        | yes (429)                                                         | `PacedTransport` / `HttpTransport` pacing + backoff             |
| Charges / CA transfers NEW → SETTLED                                                   | yes (after a read)                                                | polled                                                          |
| Webhook-shaped events (processing, sent, paid, failed, cancelled, deposit)             | emitted in-process                                                | real webhooks verified at `/webhooks/airwallex`                 |

## Webhooks

`x-signature` = hex HMAC-SHA256 over `x-timestamp + rawBody`, keyed with the subscription secret. Verified on the raw bytes (Fastify's JSON parser is replaced to keep them), with a 5-minute timestamp tolerance and a constant-time comparison. Events are deduped on `id` and should be applied sorted by `created_at`. Expected events: `payout.transfer.paid`, `payout.transfer.failed`, `payout.transfer.cancelled`.

## Not yet verified live

- Exact response field names for `charges` and `connected_account_transfers` reads.
- `GET /transfers?request_id=` filter support (if not: list and filter client-side).
- Whether `fx/rates/current` accepts `x-on-behalf-of` for connected accounts (if not: read the rate at platform level; pricing is re-checked against the locked quote anyway).
