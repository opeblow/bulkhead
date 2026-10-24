import { shortAcct, timeOf } from "../../lib/api";
import { useConsole } from "./Shell";

export function TracePage() {
  const { snap } = useConsole();
  const calls = snap?.calls ?? [];
  const name = (t: string | null) =>
    t ? (snap?.employers.find((e) => e.tenant === t)?.shortName ?? shortAcct(t)) : null;
  const tenantCalls = calls.filter((c) => c.tenantScoped && c.scope === "tenant");
  const missing = calls.filter((c) => c.tenantScoped && !c.scopeOk).length;
  return (
    <>
      <div className="topbar">
        <h1>API trace</h1>
        <span className="fig">Every Airwallex call Bulkhead made, in order</span>
        <span className="spacer" />
        <span className={`chip ${missing ? "bad" : "good"}`}>
          <span className="dot" />
          x-on-behalf-of on {tenantCalls.length - missing}/{tenantCalls.length} customer-scoped calls
        </span>
      </div>
      <div className="page">
        <section className="panel" style={{ overflow: "auto", maxHeight: "calc(100vh - 110px)" }}>
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>Time</th>
                <th>Call</th>
                <th>Purpose</th>
                <th>x-on-behalf-of</th>
                <th>request_id</th>
                <th>Result</th>
                <th>ms</th>
              </tr>
            </thead>
            <tbody>
              {[...calls].reverse().map((c) => (
                <tr key={c.seq}>
                  <td className="mono faint">{c.seq}</td>
                  <td className="mono faint">{timeOf(c.at)}</td>
                  <td className="mono">
                    <b style={{ fontWeight: 500 }}>{c.method}</b> {c.path}
                  </td>
                  <td className="muted">{c.intent}</td>
                  <td>
                    {c.onBehalfOf ? (
                      <span className="chip steel">{name(c.onBehalfOf)}</span>
                    ) : (
                      <span className="faint">platform</span>
                    )}
                  </td>
                  <td className="mono faint">{c.requestId ? `${c.requestId.slice(0, 14)}…` : ""}</td>
                  <td>
                    {c.ok ? (
                      <span className="pill paid">200</span>
                    ) : (
                      <span className="pill failed">
                        {c.status} {c.code}
                      </span>
                    )}
                  </td>
                  <td className="mono faint">{c.ms}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {calls.length === 0 && <div className="empty">No calls yet.</div>}
        </section>
      </div>
    </>
  );
}
