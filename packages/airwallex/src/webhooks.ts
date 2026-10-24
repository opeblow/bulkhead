import { createHmac, timingSafeEqual } from "node:crypto";
import type { AwxEvent } from "./types.js";

/**
 * Airwallex webhook verification: HMAC-SHA256 over `x-timestamp + rawBody` keyed with the
 * webhook secret, compared to `x-signature`. Always verify against the RAW bytes.
 */
export function signWebhook(secret: string, timestamp: string, rawBody: string): string {
  return createHmac("sha256", secret)
    .update(timestamp + rawBody)
    .digest("hex");
}

export function verifyWebhook(opts: {
  secret: string;
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: string;
  toleranceMs?: number;
  now?: number;
}): { ok: true } | { ok: false; reason: string } {
  const { secret, timestamp, signature, rawBody } = opts;
  if (!timestamp || !signature) return { ok: false, reason: "missing x-timestamp or x-signature" };
  const ts = Number(timestamp);
  const now = opts.now ?? Date.now();
  if (Number.isFinite(ts) && Math.abs(now - ts) > (opts.toleranceMs ?? 5 * 60_000)) {
    return { ok: false, reason: "timestamp outside tolerance" };
  }
  const expected = Buffer.from(signWebhook(secret, timestamp, rawBody), "hex");
  const given = Buffer.from(signature, "hex");
  if (expected.length !== given.length || !timingSafeEqual(expected, given))
    return { ok: false, reason: "bad signature" };
  return { ok: true };
}

/**
 * At-least-once, possibly out-of-order delivery: dedupe on event id, then apply in
 * created_at order. Bounded memory.
 */
export class EventInbox {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];

  constructor(private readonly capacity = 10_000) {}

  /** Returns true if this event is new and should be processed. */
  accept(e: Pick<AwxEvent, "id">): boolean {
    if (this.seen.has(e.id)) return false;
    this.seen.add(e.id);
    this.order.push(e.id);
    if (this.order.length > this.capacity) this.seen.delete(this.order.shift()!);
    return true;
  }

  static sort<T extends Pick<AwxEvent, "created_at">>(events: T[]): T[] {
    return [...events].sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
}
