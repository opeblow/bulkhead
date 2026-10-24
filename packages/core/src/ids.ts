import { createHash, randomUUID } from "node:crypto";

declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

/** Airwallex connected-account id for an employer (acct_…). */
export type TenantId = Brand<string, "TenantId">;
export type ContractorId = Brand<string, "ContractorId">;
export type RunId = Brand<string, "RunId">;
/** Airwallex idempotency key: 10–50 chars. */
export type RequestId = Brand<string, "RequestId">;

export const tenantId = (s: string): TenantId => s as TenantId;
export const contractorId = (s: string): ContractorId => s as ContractorId;
export const runId = (s: string): RunId => s as RunId;

export function newRequestId(): RequestId {
  return randomUUID() as RequestId;
}

export function assertRequestId(s: string): RequestId {
  if (s.length < 10 || s.length > 50) {
    throw new Error(`request_id must be 10–50 characters (Airwallex code 018); got ${s.length}`);
  }
  return s as RequestId;
}

/**
 * Deterministic idempotency key for one logical operation. A retry of the same
 * operation reuses the key; a different operation always gets a different key.
 * 40 characters: `bh-` + 37 hex chars of sha256(namespace|parts…).
 */
export function operationRequestId(namespace: string, ...parts: string[]): RequestId {
  const h = createHash("sha256")
    .update([namespace, ...parts].join("|"))
    .digest("hex");
  return `bh-${h.slice(0, 37)}` as RequestId;
}
