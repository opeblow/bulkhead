import { api, timeOf } from "../../lib/api";
import { useConsole } from "./Shell";

export function ApprovalsPage() {
  const { snap } = useConsole();
  const approvals = snap?.approvals ?? [];
  return (
    <>
      <div className="topbar">
        <h1>Approvals</h1>
        <span className="spacer" />
        <span className="fig">Each approval is a SHA-256 digest of exactly what you saw</span>
      </div>
      <div className="page" style={{ display: "grid", gap: 14, maxWidth: 980 }}>
        {approvals.length === 0 && (
          <div className="panel empty">No approvals yet. Start a run from the payroll page.</div>
        )}
        {[...approvals].reverse().map((a) => (
          <article key={a.id} className="panel">
            <div className="panel-head">
              <div>
                <span className="fig">
                  {a.tenantName} · {a.subject.action.replace(/_/g, " ")}
                </span>
                <h2 style={{ fontSize: 16, marginTop: 4 }}>{a.title}</h2>
              </div>
              <span
                className={`pill ${a.status === "approved" || a.status === "executed" ? "paid" : a.status === "pending" ? "awaiting_approval" : "failed"}`}
              >
                {a.status}
              </span>
            </div>
            <div className="panel-body">
              <p style={{ marginTop: 0 }}>{a.summary}</p>
              <table className="table">
                <tbody>
                  <tr>
                    <td className="faint">Amount</td>
                    <td className="mono">{a.subject.amount.display}</td>
                  </tr>
                  <tr>
                    <td className="faint">Counterparty</td>
                    <td>{a.subject.counterparty}</td>
                  </tr>
                  {Object.entries(a.subject.terms).map(([k, v]) => (
                    <tr key={k}>
                      <td className="faint">{k}</td>
                      <td>{v || "n/a"}</td>
                    </tr>
                  ))}
                  <tr>
                    <td className="faint">Evidence</td>
                    <td className="mono">{a.subject.evidence.join(" · ")}</td>
                  </tr>
                  <tr>
                    <td className="faint">Digest</td>
                    <td className="mono" style={{ wordBreak: "break-all" }}>
                      {a.digest}
                    </td>
                  </tr>
                  <tr>
                    <td className="faint">Requested</td>
                    <td className="mono">
                      {timeOf(a.requestedAt)}
                      {a.decidedAt ? ` · decided ${timeOf(a.decidedAt)} by ${a.decidedBy}` : ""}
                    </td>
                  </tr>
                </tbody>
              </table>
              {a.status === "pending" && (
                <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                  <button
                    className="btn approve sm"
                    type="button"
                    onClick={() => void api.decide(a.id, "approve")}
                  >
                    Approve exactly this
                  </button>
                  <button
                    className="btn reject sm"
                    type="button"
                    onClick={() => void api.decide(a.id, "reject")}
                  >
                    Reject
                  </button>
                </div>
              )}
            </div>
          </article>
        ))}
      </div>
    </>
  );
}
