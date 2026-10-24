# Contributing

Thanks for helping. Bulkhead moves money, so the bar for changes to money paths is high, and the process is short.

## Getting started

```bash
corepack enable
pnpm install
pnpm check        # lint + typecheck + tests
pnpm dev          # API :8787, console :5173
```

See [SETUP.md](SETUP.md) for Docker, Claude and the real sandbox. Coding agents: read [AGENTS.md](AGENTS.md).

## Workflow

1. Open an issue first for anything bigger than a small fix.
2. Branch from `main`: `feat/…`, `fix/…`, `docs/…`.
3. Keep pull requests small and focused. Fill in the PR template, including the money-safety checklist.
4. `pnpm check` and `pnpm demo` must pass. UI changes need a screenshot or `pnpm e2e`.
5. Use [Conventional Commits](https://www.conventionalcommits.org): `feat(engine): …`, `fix(airwallex): …`.
6. Add a line to `CHANGELOG.md` under _Unreleased_.

## Rules for money paths

Changes under `packages/core`, `packages/airwallex` or `packages/agent/src/engine.ts` need:
- tests for the new behaviour **and** for the failure it prevents;
- no floats on amounts (use `Money`);
- every new money-moving action routed through `evaluate()`;
- review from a second maintainer (CODEOWNERS enforces this).

The invariants in [AGENTS.md](AGENTS.md#invariants-do-not-break) are not up for casual debate. If you think one is wrong, open an issue with an ADR proposal in `docs/adr/`.

## Simulator fidelity

When you discover the real sandbox behaving differently from the simulator, that is a valuable contribution: update `packages/airwallex/src/simulator.ts`, add a test, and record it in `docs/airwallex-integration.md`.

## Style

Biome formats and lints (`pnpm format`). TypeScript strict. Comments explain _why_. UI copy is plain and specific.

## Code of conduct

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
