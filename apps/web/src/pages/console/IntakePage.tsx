import { useState } from "react";
import { api } from "../../lib/api";
import { useConsole } from "./Shell";

const SAMPLE =
  "hey bulkhead! payroll for this week pls — Jonas Berg €4,000 like usual and Priya Raman £2,800. Priya switched banks btw, new account: Monzo, sort code 04-00-04, acct 41926819. we're tight till monday, sorry";

type Parsed = Awaited<ReturnType<typeof api.parse>>;

export function IntakePage() {
  const { snap } = useConsole();
  const [text, setText] = useState(SAMPLE);
  const [employer, setEmployer] = useState("B");
  const [out, setOut] = useState<Parsed | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const parse = async () => {
    setBusy(true);
    setErr(null);
    try {
      setOut(await api.parse(text, employer));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="topbar">
        <h1>Intake lab</h1>
        <span className="fig">
          Paste any payroll message. See exactly what Bulkhead extracts before money moves.
        </span>
      </div>
      <div
        className="page"
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)",
          gap: 16,
          alignItems: "start",
        }}
      >
        <section className="panel">
          <div className="panel-head">
            <h2>Employer message</h2>
            <select
              className="input"
              style={{ width: 180, height: 32, padding: "0 8px" }}
              value={employer}
              onChange={(e) => setEmployer(e.target.value)}
              aria-label="Employer"
            >
              {snap?.employers.map((e) => (
                <option key={e.key} value={e.key}>
                  {e.shortName}
                </option>
              ))}
            </select>
          </div>
          <div className="panel-body" style={{ display: "grid", gap: 12 }}>
            <textarea
              className="input"
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-label="Message"
            />
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <button className="btn sm" type="button" disabled={busy} onClick={parse}>
                {busy ? "Reading…" : "Extract payroll"}
              </button>
              <span className="faint" style={{ fontSize: 12 }}>
                {snap?.mode.advisor === "claude"
                  ? `Claude (${snap.mode.model}) with structured output, checked against a schema`
                  : "Rule-based parser (set ANTHROPIC_API_KEY to use Claude)"}
              </span>
            </div>
            {err && <span className="chip bad">{err}</span>}
          </div>
        </section>
        <section className="panel">
          <div className="panel-head">
            <h2>What Bulkhead understood</h2>
            {out && <span className="chip">{out.source}</span>}
          </div>
          <div className="panel-body">
            {!out && <div className="empty">Nothing extracted yet.</div>}
            {out && (
              <div style={{ display: "grid", gap: 16 }}>
                <div>
                  <span className="fig">Payroll lines</span>
                  <ul className="lines" style={{ marginTop: 8 }}>
                    {out.lines.map((l) => (
                      <li key={l.contractorName} className="line">
                        <span className="who">{l.contractorName}</span>
                        <span className="amt">
                          {l.amount} {l.currency}
                        </span>
                      </li>
                    ))}
                    {out.lines.length === 0 && (
                      <li className="faint">None found on this employer's roster.</li>
                    )}
                  </ul>
                </div>
                {out.bankChanges.length > 0 && (
                  <div className="quote-card" style={{ borderLeftColor: "var(--steel)" }}>
                    <span className="fig">Bank details changed · needs a person before payment</span>
                    {out.bankChanges.map((b) => (
                      <div key={b.contractorName} className="mono" style={{ fontSize: 12.5 }}>
                        {Object.entries(b)
                          .filter(([, v]) => v)
                          .map(([k, v]) => `${k}: ${v}`)
                          .join(" · ")}
                      </div>
                    ))}
                  </div>
                )}
                {out.notes.length > 0 && (
                  <div>
                    <span className="fig">Notes for the operator</span>
                    <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                      {out.notes.map((n) => (
                        <li key={n}>{n}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
