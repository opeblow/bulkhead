# ADR 0002 · The model advises; code decides

**Status:** accepted

## Context

The builder guide: keep amounts, limits, reserves, validation, duplicate protection and state transitions in code; use the model to read unstructured text, compare evidence, propose a plan and explain an exception.

## Decision

- The engine is deterministic. Claude is called through an `Advisor` interface for intake parsing, choosing among pre-judged shortfall options, and explaining returned payouts.
- Advisor inputs are numbers already computed and formatted by code. Outputs are JSON-schema constrained (`output_config.format`) and validated with zod.
- A recommendation for a denied option, a schema failure, a refusal or an API error all fall back to `DeterministicAdvisor` for that call.
- Requests use `fallbacks: "default"` so a refusal on one model can be retried on another before falling back.

## Consequences

Runs are reproducible and cheap; model mistakes degrade to the rule-based recommendation, never to a wrong payment. The product still benefits from language understanding where rules are brittle (free-form emails, Slack messages).
