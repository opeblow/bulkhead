import type { TenantId } from "./ids.js";
import { type Currency, type Money, zero } from "./money.js";

/**
 * A sealed view of ONE employer's money, read from that employer's connected account
 * (balances/current with x-on-behalf-of). There is deliberately no API anywhere in
 * Bulkhead that adds compartments together: a funding decision can only ever see the
 * compartment of the employer it is deciding for.
 */
export interface Compartment {
  readonly tenant: TenantId;
  readonly balances: ReadonlyMap<Currency, Money>;
  readonly asOf: string;
}

export class CompartmentBreachError extends Error {
  readonly code = "COMPARTMENT_BREACH";
  constructor(
    readonly expected: TenantId,
    readonly actual: TenantId,
    context: string,
  ) {
    super(`Compartment breach in ${context}: expected ${expected}, got ${actual}`);
    this.name = "CompartmentBreachError";
  }
}

export function compartment(
  tenant: TenantId,
  balances: Iterable<[Currency, Money]>,
  asOf = new Date().toISOString(),
): Compartment {
  const map = new Map<Currency, Money>();
  for (const [ccy, m] of balances) {
    if (m.currency !== ccy) throw new Error(`Balance currency mismatch for ${ccy}`);
    map.set(ccy, m);
  }
  return Object.freeze({ tenant, balances: map, asOf });
}

export function available(c: Compartment, currency: Currency): Money {
  return c.balances.get(currency) ?? zero(currency);
}

/** Throws unless the compartment belongs to `tenant`. Called at every funding decision boundary. */
export function assertCompartment(c: Compartment, tenant: TenantId, context: string): void {
  if (c.tenant !== tenant) throw new CompartmentBreachError(tenant, c.tenant, context);
}
