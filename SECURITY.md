# Security policy

Bulkhead moves money (in a sandbox). We treat anything that could move it incorrectly as a security issue.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private vulnerability reporting (**Security → Report a vulnerability**) on this repository. Include:
- what an attacker can do, and the impact on funds or data;
- steps to reproduce (run id, request, or a failing test is ideal);
- the commit you tested.

We aim to acknowledge reports within 2 business days and to agree a fix timeline within 7.

## In scope

- Any way to fund one employer's payroll from another employer's wallet
- Any customer-scoped Airwallex call made without the correct `x-on-behalf-of`
- Duplicate payouts, or approvals executing different terms than were approved
- Webhook signature bypass, audit-chain tampering that verifies
- Prompt injection that leads to a money-moving action policy should have stopped
- Credential exposure (keys reaching the browser, logs or the model)

## Out of scope

- Findings that require a compromised host or a malicious operator with the operator token
- The intentionally unauthenticated local development mode (no `BULKHEAD_OPERATOR_TOKEN`, bound to `127.0.0.1`)
- Rate limiting of the demo server

## Handling secrets

- Credentials are read from the environment only. `.env` is gitignored; CI runs gitleaks.
- API keys are never sent to the model or the browser.
- Use sandbox keys scoped to what the agent needs. Never use production Airwallex credentials with this project.

## Hardening already in place

See [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md): isolation by construction, policy-gated actions, SHA-256-bound approvals, deterministic request ids, HMAC webhooks on raw bodies, a hash-chained audit log, CSP and security headers, constant-time token comparison, CodeQL and dependency review in CI.

## Supported versions

Only `main` is supported during the hackathon.
