# ADR 0004 · Simulator first, one transport interface

**Status:** accepted

## Context

Track 6 depends on Airwallex enabling connected accounts and platform payments on the sandbox, which takes time. Judges also need to run the project without credentials.

## Decision

`SimulatedAirwallex` and `HttpTransport` both implement `Transport`. The simulator reproduces every sandbox behaviour the builder guide documents, with tests for each. The same engine, client and recorder run against either.

## Consequences

Anyone can run the full scenario offline in seconds. The risk is drift from the real sandbox. This is mitigated by `docs/airwallex-integration.md` and the manual `sandbox-smoke` workflow.
