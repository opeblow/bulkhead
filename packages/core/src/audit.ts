import { createHash } from "node:crypto";
import { canonicalJson } from "./approvals.js";

/**
 * Tamper-evident, append-only audit trail. Each record commits to the previous record's
 * hash, so editing or deleting any past entry breaks every hash after it.
 */
export interface AuditRecord {
  readonly seq: number;
  readonly at: string;
  readonly kind: string;
  readonly tenant: string | null;
  readonly actor: "agent" | "policy" | "operator" | "airwallex" | "system";
  readonly message: string;
  readonly data: unknown;
  readonly prevHash: string;
  readonly hash: string;
}

export const GENESIS = "0".repeat(64);

export function hashRecord(r: Omit<AuditRecord, "hash">): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        seq: r.seq,
        at: r.at,
        kind: r.kind,
        tenant: r.tenant,
        actor: r.actor,
        message: r.message,
        data: r.data,
        prevHash: r.prevHash,
      }),
    )
    .digest("hex");
}

export class AuditLog {
  private readonly records: AuditRecord[] = [];
  private readonly listeners = new Set<(r: AuditRecord) => void>();

  constructor(initial: readonly AuditRecord[] = []) {
    this.records.push(...initial);
  }

  append(entry: {
    kind: string;
    tenant?: string | null;
    actor: AuditRecord["actor"];
    message: string;
    data?: unknown;
    at?: string;
  }): AuditRecord {
    const prev = this.records.at(-1);
    const base = {
      seq: (prev?.seq ?? 0) + 1,
      at: entry.at ?? new Date().toISOString(),
      kind: entry.kind,
      tenant: entry.tenant ?? null,
      actor: entry.actor,
      message: entry.message,
      data: toJsonSafe(entry.data ?? null),
      prevHash: prev?.hash ?? GENESIS,
    };
    const record: AuditRecord = Object.freeze({ ...base, hash: hashRecord(base) });
    this.records.push(record);
    for (const l of this.listeners) l(record);
    return record;
  }

  onAppend(fn: (r: AuditRecord) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  all(): readonly AuditRecord[] {
    return this.records;
  }

  head(): string {
    return this.records.at(-1)?.hash ?? GENESIS;
  }
}

export interface ChainVerification {
  readonly ok: boolean;
  readonly length: number;
  readonly head: string;
  readonly brokenAt?: number;
  readonly reason?: string;
}

export function verifyChain(records: readonly AuditRecord[]): ChainVerification {
  let prev = GENESIS;
  for (const [i, r] of records.entries()) {
    if (r.seq !== i + 1)
      return { ok: false, length: records.length, head: prev, brokenAt: r.seq, reason: "sequence gap" };
    if (r.prevHash !== prev)
      return { ok: false, length: records.length, head: prev, brokenAt: r.seq, reason: "prevHash mismatch" };
    const { hash, ...rest } = r;
    if (hashRecord(rest) !== hash)
      return { ok: false, length: records.length, head: prev, brokenAt: r.seq, reason: "content altered" };
    prev = hash;
  }
  return { ok: true, length: records.length, head: prev };
}

/** BigInt and Map are not JSON; normalise before hashing so verification is reproducible. */
export function toJsonSafe(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => {
      if (typeof v === "bigint") return v.toString();
      if (v instanceof Map) return Object.fromEntries(v);
      if (v instanceof Set) return [...v];
      return v;
    }),
  );
}
