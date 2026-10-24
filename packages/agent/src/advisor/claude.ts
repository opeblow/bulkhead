import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { DeterministicAdvisor } from "./deterministic.js";
import type {
  Advisor,
  ExceptionAdvice,
  ExceptionContext,
  ParsedSubmission,
  RosterEntry,
  ShortfallAdvice,
  ShortfallContext,
} from "./types.js";

const SYSTEM = `You are the judgement layer inside Bulkhead, a payroll platform that pays contractors on behalf of several employers through Airwallex connected accounts.

Hard facts about how you are used:
- Code computes every amount, fee, FX conversion and balance. You never invent or recompute numbers; you quote the ones you are given.
- A policy engine has already marked each option allow / require_approval / deny. You may only choose an option that is not denied.
- Each employer's money is sealed in its own compartment. Using one employer's funds for another employer's payroll is never acceptable, even when it is technically possible.
- Contractors are real people expecting to be paid. Prefer outcomes that pay as many people in full, today, from the right employer's own funds.

Write plainly and briefly, like a senior payments operator. No hedging, no marketing language.`;

const ParsedSchema = z.object({
  lines: z.array(
    z.object({
      contractorName: z.string(),
      amount: z.string(),
      currency: z.enum(["USD", "EUR", "GBP", "AUD", "SGD", "HKD", "CAD", "JPY"]),
      memo: z.string().optional(),
    }),
  ),
  bankChanges: z.array(
    z.object({
      contractorName: z.string(),
      bankName: z.string().optional(),
      sortCode: z.string().optional(),
      accountNumber: z.string().optional(),
      iban: z.string().optional(),
      swiftCode: z.string().optional(),
    }),
  ),
  notes: z.array(z.string()),
});

const AdviceSchema = z.object({
  optionId: z.enum([
    "pay_priority_then_bridge",
    "pay_priority_then_wait",
    "hold_all",
    "borrow_from_other_employer",
  ]),
  rationale: z.string(),
  employerMessage: z.string(),
});

const ExceptionSchema = z.object({ summary: z.string(), nextSteps: z.array(z.string()) });

/** JSON Schema with additionalProperties:false everywhere, as structured outputs require. */
function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
}

export interface ClaudeAdvisorOptions {
  readonly apiKey?: string;
  readonly model?: string;
  readonly client?: Anthropic;
  readonly onUsage?: (u: {
    purpose: string;
    inputTokens: number;
    outputTokens: number;
    model: string;
  }) => void;
}

/**
 * Claude-backed advisor. Structured JSON output validated with zod; on any failure (network,
 * refusal, schema mismatch, or a denied option) it falls back to the deterministic advisor.
 */
export class ClaudeAdvisor implements Advisor {
  readonly kind = "claude" as const;
  readonly model: string;
  private readonly client: Anthropic;
  private readonly fallback = new DeterministicAdvisor();

  constructor(private readonly opts: ClaudeAdvisorOptions = {}) {
    this.model = opts.model ?? "claude-opus-5-5";
    this.client = opts.client ?? new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
  }

  private async ask<T>(purpose: string, schema: z.ZodType<T>, prompt: string): Promise<T | null> {
    try {
      const params = {
        model: this.model,
        max_tokens: 4000,
        system: SYSTEM,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "medium", format: { type: "json_schema", schema: jsonSchema(schema) } },
        messages: [{ role: "user", content: prompt }],
      };
      const res = await this.client.beta.messages.create(
        params as unknown as Parameters<typeof this.client.beta.messages.create>[0] & { stream?: false },
      );
      const message = res as Anthropic.Beta.BetaMessage;
      this.opts.onUsage?.({
        purpose,
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        model: message.model,
      });
      if (message.stop_reason === "refusal" || message.stop_reason === "max_tokens") return null;
      const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      const parsed = schema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async parseSubmission(text: string, roster: readonly RosterEntry[]): Promise<ParsedSubmission> {
    const prompt = `Extract this week's payroll instructions from an employer's message.

Roster (only these people can be paid; use their exact names):
${roster.map((r) => `- ${r.name} (paid in ${r.payoutCurrency})`).join("\n")}

Rules:
- One line per person with an amount. Amount as a plain decimal string with two decimals, no symbols or separators.
- If the message says a person's bank details changed, add a bankChanges entry with whatever details are given (sort code digits only).
- notes: short factual observations an operator should know (urgency, expected funding, cash constraints). No advice.

Message:
"""
${text}
"""`;
    const out = await this.ask("parse_submission", ParsedSchema, prompt);
    if (!out) return this.fallback.parseSubmission(text, roster);
    const names = new Set(roster.map((r) => r.name));
    return {
      lines: out.lines.filter((l) => names.has(l.contractorName)),
      bankChanges: out.bankChanges.filter((b) => names.has(b.contractorName)),
      notes: out.notes,
      source: "claude",
    };
  }

  async resolveShortfall(ctx: ShortfallContext): Promise<ShortfallAdvice> {
    const prompt = `An employer cannot fully fund this week's payroll from its own wallet. Choose one option and explain.

Employer: ${ctx.employer}
Employer's own wallet: ${ctx.fundingAvailable}
Required (payouts + SWIFT fees + platform fee): ${ctx.fundingRequired}
Shortfall: ${ctx.shortfall}
Employer notes: ${ctx.employerNotes.join(" | ") || "none"}

Payroll lines:
${ctx.lines.map((l) => `- ${l.name}: ${l.amount} via ${l.method}, priority ${l.priority}`).join("\n")}

Options (computed by code, judged by policy):
${ctx.options
  .map(
    (o) =>
      `- id=${o.id} [policy: ${o.policy}] ${o.title}: ${o.description}${o.amount ? ` Amount: ${o.amount}.` : ""} Policy: ${o.policyReasons.join(" ")}`,
  )
  .join("\n")}

Return optionId (never a denied option), a rationale for the operator (2–3 sentences, cite the numbers above), and a short, warm message to the employer.`;
    const out = await this.ask("resolve_shortfall", AdviceSchema, prompt);
    const allowed = new Set(ctx.options.filter((o) => o.policy !== "deny").map((o) => o.id));
    if (!out || !allowed.has(out.optionId)) return this.fallback.resolveShortfall(ctx);
    return { ...out, source: "claude" };
  }

  async explainException(ctx: ExceptionContext): Promise<ExceptionAdvice> {
    const prompt = `A contractor payout failed. Explain it to the operator and list next steps.

Employer: ${ctx.employer}
Contractor: ${ctx.contractor}
Amount: ${ctx.amount}
Airwallex status: CANCELLED (this is how Airwallex reports a failed transfer)
failure_type: ${ctx.failureType}
failure_reason: ${ctx.failureReason}
SWIFT fee not refunded: ${ctx.feeLost}

Constraint: never recommend resending automatically before the cause is fixed; paying twice is worse than paying late.`;
    const out = await this.ask("explain_exception", ExceptionSchema, prompt);
    return out ? { ...out, source: "claude" } : this.fallback.explainException(ctx);
  }
}
