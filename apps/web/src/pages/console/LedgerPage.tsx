import { useState } from "react";
import { timeOf } from "../../lib/api";
import { useConsole } from "./Shell";

export function LedgerPage() {
  const { snap } = useConsole();
  const [filter, setFilter] = useState("all");
  const name = (t: string) =>
    snap?.employers.find((e) => e.tenant === t)?.shortName ??
    (t === "platform" ? "Platform" : t === "external" ? "External" : t);
  const journals = (snap?.ledger ?? []).filter((j) => filter === "all" || j.tenant === filter);
  const rec = snap?.proofs?.reconciliation;
  return (
    <>
      <div className="topbar">
        <h1>Ledger</h1>
        <span className="fig">
          Double-entry · balanced in every currency · never two employers in one entry
        </span>
        <span className="spacer" />
        <select
          className="input"
          style={{ width: 200, height: 34, padding: "0 10px" }}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter by employer"
        >
          <option value="all">All employers</option>
          {snap?.employers.map((e) => (
            <option key={e.tenant} value={e.tenant}>
              {e.shortName}
            </option>
          ))}
        </select>
      </div>
      <div className="page" style={{ display: "grid", gap: 16 }}>
        {rec && (
          <section className="panel">
            <div className="panel-head">
              <h2>Reconciliation against Airwallex balances</h2>
              <span className={`chip ${rec.ok ? "good" : "bad"}`}>{rec.ok ? "All match" : "Mismatch"}</span>
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>Employer</th>
                  <th>Currency</th>
                  <th>Opening + ledger</th>
                  <th>Airwallex balance</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rec.rows.map((r) => (
                  <tr key={`${r.tenant}${r.currency}`}>
                    <td>{r.name}</td>
                    <td className="mono">{r.currency}</td>
                    <td className="mono">{r.expected}</td>
                    <td className="mono">{r.actual}</td>
                    <td>
                      {r.ok ? <span className="chip good">✓</span> : <span className="chip bad">✗</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
        <section className="panel">
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Entry</th>
                <th>Employer</th>
                <th>Legs</th>
              </tr>
            </thead>
            <tbody>
              {journals.length === 0 && (
                <tr>
                  <td colSpan={4} className="empty">
                    No ledger entries yet.
                  </td>
                </tr>
              )}
              {[...journals].reverse().map((j) => (
                <tr key={j.id}>
                  <td className="mono faint">{timeOf(j.at)}</td>
                  <td>
                    <span className="pill">{j.kind.replace(/_/g, " ")}</span>
                    <div style={{ marginTop: 4 }}>{j.memo}</div>
                  </td>
                  <td>{name(j.tenant)}</td>
                  <td>
                    {j.legs.map((l, i) => (
                      <div
                        // biome-ignore lint/suspicious/noArrayIndexKey: journal legs are immutable and never reorder
                        key={`${j.id}-${i}`}
                        className="mono"
                        style={{
                          fontSize: 12,
                          display: "grid",
                          gridTemplateColumns: "120px 1fr 120px",
                          gap: 8,
                        }}
                      >
                        <span className="faint">{name(l.owner)}</span>
                        <span>{l.account}</span>
                        <span
                          style={{
                            textAlign: "right",
                            color: l.amount.amount.startsWith("-") ? "var(--ink)" : "var(--sea)",
                          }}
                        >
                          {l.amount.display}
                        </span>
                      </div>
                    ))}
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
