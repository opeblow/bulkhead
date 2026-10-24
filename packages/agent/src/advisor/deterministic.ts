import { type Currency, isCurrency } from "@bulkhead/core";
import type {
  Advisor,
  ExceptionAdvice,
  ExceptionContext,
  ParsedBankChange,
  ParsedLine,
  ParsedSubmission,
  RosterEntry,
  ShortfallAdvice,
  ShortfallContext,
} from "./types.js";

const SYMBOLS: Record<string, Currency> = { "€": "EUR", "£": "GBP", $: "USD" };

/**
 * Rule-based advisor. Same contract as the Claude advisor, used offline and as the fallback
 * whenever the model is unavailable or proposes something policy does not allow.
 */
export class DeterministicAdvisor implements Advisor {
  readonly kind = "deterministic" as const;

  async parseSubmission(text: string, roster: readonly RosterEntry[]): Promise<ParsedSubmission> {
    const lines: ParsedLine[] = [];
    const notes: string[] = [];
    const firstLine = text.split(/\r?\n/)[0]?.toLowerCase() ?? "";

    if (firstLine.includes("amount") && firstLine.includes("currency")) {
      const header = firstLine.split(",").map((h) => h.trim());
      for (const row of text.split(/\r?\n/).slice(1)) {
        if (!row.trim()) continue;
        const cells = row.split(",").map((c) => c.trim());
        const rec = Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""]));
        const ccy = (rec.currency ?? "").toUpperCase();
        if (!isCurrency(ccy)) continue;
        lines.push({
          contractorName: rec.contractor ?? rec.name ?? "",
          amount: normalise(rec.amount ?? "0"),
          currency: ccy,
          memo: rec.memo,
        });
      }
    } else {
      for (const person of roster) {
        const idx = text.toLowerCase().indexOf(person.name.toLowerCase());
        if (idx < 0) continue;
        const window = text.slice(idx + person.name.length, idx + person.name.length + 40);
        const m = window.match(/([€£$])\s?([\d,]+(?:\.\d{1,2})?)|([\d,]+(?:\.\d{1,2})?)\s?(EUR|GBP|USD)/);
        if (!m) continue;
        const ccy = m[1] ? SYMBOLS[m[1]] : (m[4] as Currency);
        const amt = m[2] ?? m[3] ?? "0";
        if (ccy) lines.push({ contractorName: person.name, amount: normalise(amt), currency: ccy });
      }
    }

    const bankChanges: ParsedBankChange[] = [];
    if (/(changed banks|new (bank )?account|new (bank )?details|switched banks)/i.test(text)) {
      const who = roster.find((p) =>
        new RegExp(`${p.name.split(" ")[0]}[^.]{0,30}(changed|switched|new)`, "i").test(text),
      );
      if (who) {
        const sort = text.match(/sort code\s*:?\s*(\d{2})-?(\d{2})-?(\d{2})/i);
        const acct = text.match(/(?:acct|account(?: number)?)\s*:?\s*(\d{6,12})/i);
        const iban = text.match(/\b([A-Z]{2}\d{2}[A-Z0-9]{11,30})\b/);
        const bank = text.match(/new (?:bank )?account:?\s*([A-Z][A-Za-z]+)/);
        bankChanges.push({
          contractorName: who.name,
          bankName: bank?.[1],
          sortCode: sort ? `${sort[1]}${sort[2]}${sort[3]}` : undefined,
          accountNumber: acct?.[1],
          iban: iban?.[1],
        });
      }
    }

    if (/tight|short|until .* clears|late/i.test(text))
      notes.push("Employer signals cash is tight; expect a shortfall.");
    if (/paid today|expecting to be paid today|need(s)? to be paid today/i.test(text))
      notes.push("Contractors expect payment today.");
    if (/wire lands|deposit (lands|arrives)|funding .* (today|this morning)/i.test(text))
      notes.push("Employer says funding arrives later today.");

    return { lines, bankChanges, notes, source: "deterministic" };
  }

  async resolveShortfall(ctx: ShortfallContext): Promise<ShortfallAdvice> {
    const bridge = ctx.options.find((o) => o.id === "pay_priority_then_bridge" && o.policy !== "deny");
    const wait = ctx.options.find((o) => o.id === "pay_priority_then_wait" && o.policy !== "deny");
    const chosen = bridge ?? wait ?? ctx.options.find((o) => o.policy !== "deny")!;
    const paid = chosen.payNow.join(", ") || "nobody yet";
    const held = chosen.hold.join(", ") || "nobody";
    return {
      optionId: chosen.id,
      source: "deterministic",
      rationale:
        `${ctx.employer} holds ${ctx.fundingAvailable} against ${ctx.fundingRequired} required (short ${ctx.shortfall}). ` +
        `Paying ${paid} now from their own wallet is fully covered. ` +
        (chosen.id === "pay_priority_then_bridge"
          ? `${held} can be paid today only with a platform bridge of ${chosen.amount}, which needs your approval and is repaid from their next deposit. `
          : `${held} waits for the employer's top-up. `) +
        "Funds from other employers were considered and refused by policy.",
      employerMessage:
        `Hi ${ctx.employer} team, this week's payroll needs ${ctx.fundingRequired} including fees and your wallet holds ${ctx.fundingAvailable}. ` +
        `We've paid ${paid} in full. ` +
        (chosen.id === "pay_priority_then_bridge"
          ? `To pay ${held} today we've requested a short bridge of ${chosen.amount}, repaid automatically from your next deposit.`
          : `${held} will be paid as soon as a top-up of ${ctx.shortfall} lands in your wallet.`),
    };
  }

  async explainException(ctx: ExceptionContext): Promise<ExceptionAdvice> {
    return {
      source: "deterministic",
      summary: `${ctx.contractor}'s payout of ${ctx.amount} from ${ctx.employer} came back: ${ctx.failureReason}. The funds are back in ${ctx.employer}'s wallet; the ${ctx.feeLost} SWIFT fee is not refunded.`,
      nextSteps: [
        "Do not resend automatically: the beneficiary account is the problem, not the transfer.",
        `Ask ${ctx.contractor} for corrected bank details and verify them out-of-band.`,
        "Re-run this single line once the new beneficiary is approved; the original transfer stays recorded as CANCELLED.",
      ],
    };
  }
}

function normalise(amount: string): string {
  const clean = amount.replace(/,/g, "");
  return clean.includes(".") ? clean : `${clean}.00`;
}
