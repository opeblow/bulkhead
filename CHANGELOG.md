# Changelog

All notable changes to this project. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org).

## [Unreleased]

## [0.1.0] · 2026-10-23

### Added

- `@bulkhead/core`: exact bigint money, per-employer compartments, payroll pricing with SWIFT fees counted before FX, rationing inside one compartment, policy engine (tenant isolation, fees before conversion, bridge approval/cap/floor, bank-change review, fee after payroll, duplicate payout lock, FX drift), SHA-256-bound approvals, double-entry ledger with an isolation check on every entry, hash-chained audit log.
- `@bulkhead/airwallex`: typed `PlatformClient` / `TenantClient` (always sends `x-on-behalf-of`), `HttpTransport` with token caching, pacing and 429 backoff, `RecordingTransport` with header-coverage proof, webhook HMAC verification and dedupe, and a sandbox simulator covering every Track 6 watch-out.
- `@bulkhead/agent`: three-employer run engine with intake, shortfall decisions, platform bridge with repayment, bank-return handling, reconciliation and proofs; Claude advisor (`claude-opus-5-5`, structured outputs, `fallbacks: "default"`) and a rule-based advisor.
- `@bulkhead/api`: REST + Server-Sent Events, operator token, security headers, webhook endpoint, headless demo CLI, sandbox smoke script.
- `@bulkhead/web`: landing page and console (run, approvals, ledger, API trace, audit chain, intake lab).
- CI (Linux + Windows, Node 22/24), Playwright e2e, Docker smoke test, CodeQL, dependency review, pnpm audit, gitleaks, Dependabot.
- A 2:54 product launch film (produced outside the repository, shared as a video link).
