import { useEffect, useState } from "react";
import { api, timeOf } from "../../lib/api";
import { useConsole } from "./Shell";

interface Rec {
  seq: number;
  at: string;
  kind: string;
  actor: string;
  message: string;
  prevHash: string;
  hash: string;
  tenant: string | null;
}

export function AuditPage() {
  const { snap } = useConsole();
  const [data, setData] = useState<{
    verification: { ok: boolean; length: number; head: string };
    records: Rec[];
  } | null>(null);
  const len = snap?.timeline.length ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh when the timeline grows
  useEffect(() => {
    api
      .audit()
      .then(setData)
      .catch(() => undefined);
  }, [len]);
  const name = (t: string | null) => snap?.employers.find((e) => e.tenant === t)?.shortName ?? "platform";
  return (
    <>
      <div className="topbar">
        <h1>Audit chain</h1>
        <span className="fig">Append-only · each record commits to the previous record's hash</span>
        <span className="spacer" />
        {data && (
          <span className={`chip ${data.verification.ok ? "good" : "bad"}`}>
            <span className="dot" />
            {data.verification.ok ? "Verified" : "Broken"} · {data.verification.length} records · head{" "}
            {data.verification.head.slice(0, 12)}…
          </span>
        )}
      </div>
      <div className="page">
        <section className="panel" style={{ overflow: "auto", maxHeight: "calc(100vh - 110px)" }}>
          <table className="table">
            <thead>
              <tr>
                <th>Seq</th>
                <th>Time</th>
                <th>Actor</th>
                <th>Employer</th>
                <th>Event</th>
                <th>prev → hash</th>
              </tr>
            </thead>
            <tbody>
              {[...(data?.records ?? [])].reverse().map((r) => (
                <tr key={r.seq}>
                  <td className="mono">{r.seq}</td>
                  <td className="mono faint">{timeOf(r.at)}</td>
                  <td>
                    <span className="pill">{r.actor}</span>
                  </td>
                  <td>{name(r.tenant)}</td>
                  <td>
                    <div>{r.message}</div>
                    <div className="mono faint" style={{ fontSize: 11 }}>
                      {r.kind}
                    </div>
                  </td>
                  <td className="mono faint" style={{ fontSize: 11 }}>
                    {r.prevHash.slice(0, 8)} →{" "}
                    <span style={{ color: "var(--ink)" }}>{r.hash.slice(0, 8)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </>
  );
}
