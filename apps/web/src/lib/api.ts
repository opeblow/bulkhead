import type { Snapshot } from "@bulkhead/agent";
import { useEffect, useRef, useState } from "react";

export type { Snapshot };
export type Lane = NonNullable<Snapshot["run"]>["lanes"][number];
export type Line = Lane["lines"][number];

const OPERATOR_KEY = "bulkhead.operatorToken";

function headers(): HeadersInit {
  let token = "";
  try {
    token = localStorage.getItem(OPERATOR_KEY) ?? "";
  } catch {
    // storage unavailable
  }
  return { "content-type": "application/json", ...(token ? { "x-bulkhead-operator": token } : {}) };
}

async function post<T = unknown>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(path, { method: "POST", headers: headers(), body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json;
}

export const api = {
  startRun: (opts: { scriptedDeposit?: boolean; injectBankReturn?: string | null }) =>
    post<{ id: string }>("/api/runs", opts),
  decide: (id: string, decision: "approve" | "reject", note?: string) =>
    post(`/api/approvals/${id}/decision`, { decision, note }),
  deposit: (key: string, amount: string, payer?: string) =>
    post(`/api/employers/${key}/deposit`, { amount, payer }),
  reset: () => post("/api/reset"),
  parse: (text: string, employer: string) =>
    post<{
      lines: { contractorName: string; amount: string; currency: string; memo?: string }[];
      bankChanges: Record<string, string>[];
      notes: string[];
      source: string;
    }>("/api/intake/parse", { text, employer }),
  audit: () => fetch("/api/audit").then((r) => r.json()),
};

/** Live snapshot over Server-Sent Events, with polling fallback. */
export function useSnapshot(): { snap: Snapshot | null; connected: boolean } {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const last = useRef("");

  useEffect(() => {
    let es: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let closed = false;

    // Snapshots are full state; the newest one always wins. A reset starts a new engine,
    // so versions restart and are compared within one engine instance only.
    const accept = (s: Snapshot) => {
      if (s.generatedAt >= last.current) {
        last.current = s.generatedAt;
        setSnap(s);
      }
    };

    const startPolling = () => {
      if (poll) return;
      poll = setInterval(async () => {
        try {
          const r = await fetch("/api/state");
          if (r.ok) accept(await r.json());
        } catch {
          setConnected(false);
        }
      }, 1500);
    };

    try {
      es = new EventSource("/api/events");
      es.addEventListener("snapshot", (e) => {
        setConnected(true);
        accept(JSON.parse((e as MessageEvent).data));
      });
      es.onerror = () => {
        setConnected(false);
        if (!closed) startPolling();
      };
    } catch {
      startPolling();
    }
    fetch("/api/state")
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => s && accept(s))
      .catch(() => undefined);

    return () => {
      closed = true;
      es?.close();
      if (poll) clearInterval(poll);
    };
  }, []);

  return { snap, connected };
}

export function shortAcct(id: string): string {
  return id.length > 18 ? `${id.slice(0, 10)}…${id.slice(-4)}` : id;
}

export function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export const STATUS_LABEL: Record<string, string> = {
  idle: "Queued",
  intake: "Reading",
  pricing: "Pricing",
  awaiting_funds: "Awaiting funds",
  short: "Short",
  executing: "Paying",
  awaiting_approval: "Needs approval",
  settling_fee: "Fee",
  complete: "Complete",
  partial: "Partial",
  held: "Held",
  queued: "Queued",
  converting: "Converting",
  paying: "Paying",
  processing: "Processing",
  sent: "Sent",
  paid: "Paid",
  failed: "Returned",
};
