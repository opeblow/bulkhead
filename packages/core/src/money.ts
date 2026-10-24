/**
 * Exact money arithmetic. Amounts are held as integer minor units (bigint) and
 * are only converted to Airwallex "major unit" decimal strings at the API edge.
 * Floating point never touches a balance.
 */

export type Currency = "USD" | "EUR" | "GBP" | "AUD" | "SGD" | "HKD" | "CAD" | "JPY";

const EXPONENT: Record<Currency, number> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  AUD: 2,
  SGD: 2,
  HKD: 2,
  CAD: 2,
  JPY: 0,
};

export interface Money {
  readonly currency: Currency;
  /** Integer amount in minor units (cents, pence…). */
  readonly minor: bigint;
}

export class CurrencyMismatchError extends Error {
  constructor(a: Currency, b: Currency) {
    super(`Currency mismatch: ${a} vs ${b}`);
    this.name = "CurrencyMismatchError";
  }
}

export function isCurrency(value: string): value is Currency {
  return Object.hasOwn(EXPONENT, value);
}

export function exponent(currency: Currency): number {
  return EXPONENT[currency];
}

export function money(currency: Currency, minor: bigint): Money {
  return { currency, minor };
}

export function zero(currency: Currency): Money {
  return { currency, minor: 0n };
}

function numberToPlainString(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`Invalid amount ${n}`);
  const fixed = n.toFixed(8);
  return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
}

/** Parse a major-unit decimal ("4000", "7525.70", 12.85) into exact minor units. */
export function parseMoney(amount: string | number, currency: Currency): Money {
  const text = typeof amount === "number" ? numberToPlainString(amount) : amount.trim().replace(/,/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(text)) throw new Error(`Invalid amount "${text}"`);
  const negative = text.startsWith("-");
  const [whole = "0", frac = ""] = text.replace("-", "").split(".");
  const exp = EXPONENT[currency];
  if (frac.length > exp && /[1-9]/.test(frac.slice(exp))) {
    throw new Error(`Amount ${text} has more precision than ${currency} allows`);
  }
  const minor = BigInt(whole + frac.padEnd(exp, "0").slice(0, exp));
  return { currency, minor: negative ? -minor : minor };
}

/** Major-unit decimal string as Airwallex expects ("7525.70"). */
export function toMajor(m: Money): string {
  const exp = EXPONENT[m.currency];
  const negative = m.minor < 0n;
  const abs = negative ? -m.minor : m.minor;
  const s = abs.toString().padStart(exp + 1, "0");
  const whole = exp === 0 ? s : s.slice(0, -exp);
  const frac = exp === 0 ? "" : `.${s.slice(-exp)}`;
  return `${negative ? "-" : ""}${whole}${frac}`;
}

export function toNumber(m: Money): number {
  return Number(toMajor(m));
}

const SYMBOL: Partial<Record<Currency, string>> = { USD: "$", EUR: "€", GBP: "£", JPY: "¥" };

/** Human formatting: "$9,000.00", "€4,000.00". */
export function format(m: Money): string {
  const major = toMajor(m);
  const negative = major.startsWith("-");
  const [whole = "0", frac] = major.replace("-", "").split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sym = SYMBOL[m.currency];
  const body = `${grouped}${frac ? `.${frac}` : ""}`;
  return `${negative ? "−" : ""}${sym ? `${sym}${body}` : `${body} ${m.currency}`}`;
}

function same(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
}

export function add(a: Money, b: Money): Money {
  same(a, b);
  return { currency: a.currency, minor: a.minor + b.minor };
}

export function sub(a: Money, b: Money): Money {
  same(a, b);
  return { currency: a.currency, minor: a.minor - b.minor };
}

export function sum(currency: Currency, items: readonly Money[]): Money {
  return items.reduce((acc, m) => add(acc, m), zero(currency));
}

export function cmp(a: Money, b: Money): -1 | 0 | 1 {
  same(a, b);
  return a.minor < b.minor ? -1 : a.minor > b.minor ? 1 : 0;
}

export const gte = (a: Money, b: Money): boolean => cmp(a, b) >= 0;
export const lt = (a: Money, b: Money): boolean => cmp(a, b) < 0;
export const isZero = (a: Money): boolean => a.minor === 0n;
export const isPositive = (a: Money): boolean => a.minor > 0n;

export function max(a: Money, b: Money): Money {
  return gte(a, b) ? a : b;
}

export function clampZero(a: Money): Money {
  return a.minor < 0n ? zero(a.currency) : a;
}

export type Rounding = "up" | "down" | "half-up";

/** Exact decimal rate as a scaled integer, e.g. "1.0842" -> { n: 10842n, scale: 4 }. */
export interface Rate {
  readonly n: bigint;
  readonly scale: number;
  readonly text: string;
}

export function parseRate(text: string | number): Rate {
  const t = typeof text === "number" ? numberToPlainString(text) : text.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error(`Invalid rate "${t}"`);
  const [w = "0", f = ""] = t.split(".");
  const n = BigInt(w + f);
  if (n === 0n) throw new Error("Rate must be positive");
  return { n, scale: f.length, text: t };
}

function divRound(num: bigint, den: bigint, rounding: Rounding): bigint {
  const q = num / den;
  const r = num % den;
  if (r === 0n) return q;
  if (rounding === "down") return q;
  if (rounding === "up") return q + 1n;
  return r * 2n >= den ? q + 1n : q;
}

/** Convert `amount` into `to` at `rate`, where rate = units of `to` per 1 unit of amount.currency. */
export function convert(amount: Money, to: Currency, rate: Rate, rounding: Rounding): Money {
  const shift = EXPONENT[to] - EXPONENT[amount.currency];
  let num = amount.minor * rate.n;
  let den = 10n ** BigInt(rate.scale);
  if (shift >= 0) num *= 10n ** BigInt(shift);
  else den *= 10n ** BigInt(-shift);
  return { currency: to, minor: divRound(num, den, rounding) };
}

/**
 * Sell-currency amount needed to buy `buy`, when `rate` is buy-units per 1 sell-unit.
 * Always rounds up: payroll must never be under-converted.
 */
export function sellNeededFor(buy: Money, sell: Currency, rate: Rate): Money {
  const shift = EXPONENT[sell] - EXPONENT[buy.currency];
  let num = buy.minor * 10n ** BigInt(rate.scale);
  let den = rate.n;
  if (shift >= 0) num *= 10n ** BigInt(shift);
  else den *= 10n ** BigInt(-shift);
  return { currency: sell, minor: divRound(num, den, "up") };
}

/** Basis points of an amount (75 bps = 0.75%). */
export function bps(amount: Money, basisPoints: number, rounding: Rounding = "half-up"): Money {
  return {
    currency: amount.currency,
    minor: divRound(amount.minor * BigInt(basisPoints), 10_000n, rounding),
  };
}

/** JSON-safe representation for transport to the UI. */
export interface MoneyDTO {
  currency: Currency;
  amount: string;
  display: string;
}

export function dto(m: Money): MoneyDTO {
  return { currency: m.currency, amount: toMajor(m), display: format(m) };
}
