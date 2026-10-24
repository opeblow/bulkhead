/**
 * Airwallex payout state machine, as observed in the sandbox:
 *  - A failed transfer ends in CANCELLED (never "FAILED"); read failure_type / failure_reason.
 *  - SENT is in flight, never final.
 *  - Transfers created on a connected account's behalf stay in PROCESSING until simulated.
 */
export type TransferStatus = "CREATED" | "PROCESSING" | "SENT" | "PAID" | "CANCELLED";

const NEXT: Record<TransferStatus, readonly TransferStatus[]> = {
  CREATED: ["PROCESSING", "CANCELLED"],
  PROCESSING: ["SENT", "PAID", "CANCELLED"],
  SENT: ["PAID", "CANCELLED"],
  PAID: [],
  CANCELLED: [],
};

export function canTransition(from: TransferStatus, to: TransferStatus): boolean {
  return NEXT[from].includes(to);
}

export function isTerminal(s: TransferStatus): boolean {
  return s === "PAID" || s === "CANCELLED";
}

/** Platform charges and connected-account transfers come back NEW; only SETTLED is final. */
export type PlatformMovementStatus = "NEW" | "PENDING" | "SETTLED" | "FAILED";

export function isSettled(s: PlatformMovementStatus): boolean {
  return s === "SETTLED";
}

/** Airwallex returns three different insufficient-funds codes depending on the endpoint. */
export const INSUFFICIENT_FUNDS_CODES = {
  transfer: "balance_insufficient",
  charge: "insufficient_fund",
  conversion: "insufficient_funds",
} as const;

export function isInsufficientFunds(code: string | undefined): boolean {
  return !!code && (Object.values(INSUFFICIENT_FUNDS_CODES) as string[]).includes(code);
}
