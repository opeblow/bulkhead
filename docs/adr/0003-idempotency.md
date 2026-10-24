# ADR 0003 · Deterministic request ids and lookup-before-retry

**Status:** accepted

## Context

Airwallex rejects a reused `request_id` within seven days, and an ambiguous failure (timeout, 5xx) does not tell you whether a transfer was created.

## Decision

- `operationRequestId(namespace, ...parts)` derives a 40-character id from the run and the operation (for example `payout | run | contractor`). A retry of the same operation reuses it; anything new gets a new id.
- `TenantClient.createTransferOnce` treats any non-definitive failure as ambiguous, looks the id up with `GET /transfers?request_id=`, and only retries when nothing exists.
- Policy holds a duplicate lock per `(run, contractor)`.

## Consequences

A crash and restart within a run cannot double-pay. In production the request ids and their outcomes would be persisted (unique index) so the lock survives restarts.
