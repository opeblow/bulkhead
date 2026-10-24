import { assertCompartment, available, type Compartment } from "./compartment.js";
import type { Contractor, FeeSchedule, PayrollLine, TransferMethod } from "./domain.js";
import type { ContractorId, TenantId } from "./ids.js";
import {
  add,
  bps,
  type Currency,
  clampZero,
  isPositive,
  lt,
  type Money,
  parseMoney,
  type Rate,
  sellNeededFor,
  sub,
  sum,
  zero,
} from "./money.js";

export interface FxRate {
  /** Units of `buy` per 1 unit of `sell`. */
  readonly rate: Rate;
  readonly sell: Currency;
  readonly buy: Currency;
  readonly quoteId?: string;
  readonly validTo?: string;
  readonly source: "quote" | "indicative";
}

export type RateBook = (sell: Currency, buy: Currency) => FxRate;

export interface PricedLine {
  readonly contractorId: ContractorId;
  readonly contractorName: string;
  readonly method: TransferMethod;
  readonly payout: Money;
  /** SWIFT flat fee in payout currency, zero for LOCAL. Debited from the same wallet. */
  readonly transferFee: Money;
  readonly priority: number;
}

export interface CurrencyRequirement {
  readonly currency: Currency;
  readonly payouts: Money;
  readonly transferFees: Money;
  /** payouts + transferFees */
  readonly required: Money;
  /** Already sitting in this employer's wallet in that currency. */
  readonly onHand: Money;
  /** required − onHand, floored at zero. Fees are included BEFORE converting. */
  readonly toBuy: Money;
}

export interface ConversionPlan {
  readonly buy: Money;
  readonly sell: Money;
  readonly fx: FxRate;
}

export interface PayrollQuote {
  readonly tenant: TenantId;
  readonly fundingCurrency: Currency;
  readonly lines: readonly PricedLine[];
  readonly requirements: readonly CurrencyRequirement[];
  readonly conversions: readonly ConversionPlan[];
  /** Gross payroll expressed in funding currency (converted legs at quote rate + direct legs). */
  readonly grossInFunding: Money;
  readonly platformFee: Money;
  /** Everything this employer must have in its funding wallet: conversions + direct payouts/fees + platform fee. */
  readonly fundingRequired: Money;
  readonly fundingAvailable: Money;
  readonly shortfall: Money;
  readonly fundable: boolean;
  readonly compartmentAsOf: string;
}

export interface PriceInput {
  readonly tenant: TenantId;
  readonly fundingCurrency: Currency;
  readonly lines: readonly PayrollLine[];
  readonly contractors: ReadonlyMap<ContractorId, Contractor>;
  /** MUST be this employer's own compartment. Asserted. */
  readonly compartment: Compartment;
  readonly rates: RateBook;
  readonly fees: FeeSchedule;
}

/**
 * Price one employer's payroll entirely inside that employer's compartment.
 *
 * Watch-outs from the Airwallex Track 6 brief, enforced here:
 *  - SWIFT fees are added per payout BEFORE sizing the conversion, so the last payout cannot fail
 *    on insufficient funds.
 *  - Transfer method comes from the contractor record, never inferred from a missing fee.
 *  - Funding availability is read from this tenant only; there is no cross-tenant sum.
 */
export function priceEmployerPayroll(input: PriceInput): PayrollQuote {
  const { tenant, fundingCurrency, compartment, fees } = input;
  assertCompartment(compartment, tenant, "priceEmployerPayroll");

  const lines: PricedLine[] = input.lines.map((line) => {
    if (line.tenant !== tenant) {
      throw new Error(`Payroll line for ${line.tenant} submitted under ${tenant}`);
    }
    const c = input.contractors.get(line.contractorId);
    if (!c) throw new Error(`Unknown contractor ${line.contractorId}`);
    if (c.tenant !== tenant) throw new Error(`Contractor ${c.id} belongs to ${c.tenant}, not ${tenant}`);
    if (line.amount.currency !== c.payoutCurrency) {
      throw new Error(`Line currency ${line.amount.currency} != contractor currency ${c.payoutCurrency}`);
    }
    const swiftFee = fees.swift[c.payoutCurrency];
    const transferFee =
      c.method === "SWIFT"
        ? parseMoney(swiftFee ?? missingFee(c.payoutCurrency), c.payoutCurrency)
        : zero(c.payoutCurrency);
    return {
      contractorId: c.id,
      contractorName: c.name,
      method: c.method,
      payout: line.amount,
      transferFee,
      priority: c.priority,
    };
  });

  const currencies = [...new Set(lines.map((l) => l.payout.currency))].sort();
  const requirements: CurrencyRequirement[] = currencies.map((ccy) => {
    const ls = lines.filter((l) => l.payout.currency === ccy);
    const payouts = sum(
      ccy,
      ls.map((l) => l.payout),
    );
    const transferFees = sum(
      ccy,
      ls.map((l) => l.transferFee),
    );
    const required = add(payouts, transferFees);
    // The funding wallet's own balance is reserved for funding, so it is not "on hand" for direct legs twice.
    const onHand = ccy === fundingCurrency ? zero(ccy) : available(compartment, ccy);
    return {
      currency: ccy,
      payouts,
      transferFees,
      required,
      onHand,
      toBuy: clampZero(sub(required, onHand)),
    };
  });

  const conversions: ConversionPlan[] = requirements
    .filter((r) => r.currency !== fundingCurrency && isPositive(r.toBuy))
    .map((r) => {
      const fx = input.rates(fundingCurrency, r.currency);
      if (fx.sell !== fundingCurrency || fx.buy !== r.currency)
        throw new Error("Rate book returned wrong pair");
      return { buy: r.toBuy, sell: sellNeededFor(r.toBuy, fundingCurrency, fx.rate), fx };
    });

  const direct = requirements.find((r) => r.currency === fundingCurrency)?.required ?? zero(fundingCurrency);
  const conversionSpend = sum(
    fundingCurrency,
    conversions.map((c) => c.sell),
  );

  // Gross payroll in funding currency excludes transfer fees; used as the platform fee base.
  const grossInFunding = sum(
    fundingCurrency,
    requirements.map((r) =>
      r.currency === fundingCurrency
        ? r.payouts
        : sellNeededFor(r.payouts, fundingCurrency, input.rates(fundingCurrency, r.currency).rate),
    ),
  );
  const perPayout = parseMoney(fees.platform.perPayout, fundingCurrency);
  const platformFee = add(bps(grossInFunding, fees.platform.bps, "up"), {
    currency: fundingCurrency,
    minor: perPayout.minor * BigInt(lines.length),
  });

  const fundingRequired = add(add(conversionSpend, direct), platformFee);
  const fundingAvailable = available(compartment, fundingCurrency);
  const shortfall = clampZero(sub(fundingRequired, fundingAvailable));

  return {
    tenant,
    fundingCurrency,
    lines,
    requirements,
    conversions,
    grossInFunding,
    platformFee,
    fundingRequired,
    fundingAvailable,
    shortfall,
    fundable: !lt(fundingAvailable, fundingRequired),
    compartmentAsOf: compartment.asOf,
  };
}

function missingFee(ccy: Currency): never {
  throw new Error(`No SWIFT fee configured for ${ccy}; refusing to guess`);
}

export interface PartialPlan {
  readonly paid: readonly ContractorId[];
  readonly held: readonly ContractorId[];
  readonly quote: PayrollQuote | null;
}

/**
 * Ration payroll INSIDE one employer's compartment: include lines by priority (then smallest first)
 * while the re-priced subset stays fundable. Never looks outside the compartment.
 */
export function planWithinCompartment(input: PriceInput): PartialPlan {
  const ordered = [...input.lines].sort((a, b) => {
    const pa = input.contractors.get(a.contractorId)?.priority ?? 99;
    const pb = input.contractors.get(b.contractorId)?.priority ?? 99;
    return pa - pb || Number(a.amount.minor - b.amount.minor);
  });
  const chosen: PayrollLine[] = [];
  let best: PayrollQuote | null = null;
  for (const line of ordered) {
    const trial = priceEmployerPayroll({ ...input, lines: [...chosen, line] });
    if (trial.fundable) {
      chosen.push(line);
      best = trial;
    }
  }
  const paid = chosen.map((l) => l.contractorId);
  return {
    paid,
    held: input.lines.map((l) => l.contractorId).filter((id) => !paid.includes(id)),
    quote: best,
  };
}
