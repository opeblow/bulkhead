# ADR 0001 · Isolation by construction

**Status:** accepted

## Context

Track 6's failure mode is an agent that sums balances across tenants. Airwallex will execute a cross-account transfer if the platform authorises it, so the API is not a safety net.

## Decision

Make the unsafe thing hard to express:
- Funding decisions take a `Compartment`, which is built from one tenant's `balances/current` call, and `assertCompartment` throws on mismatch.
- There is no function anywhere that adds compartments. The only cross-tenant sum is `Snapshot.naiveAggregate`, which is display-only and labelled as such in the UI.
- Customer-scoped calls exist only on `TenantClient`, which cannot be constructed without an `acct_` id and always sets `x-on-behalf-of`.
- The ledger rejects any entry with legs owned by two different tenants.

## Consequences

Isolation holds even when someone forgets a rule. A legitimate cross-tenant flow (there is none in payroll) would need a new, reviewed journal kind.
