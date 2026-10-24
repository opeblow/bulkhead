import { useEffect, useState } from "react";
import { Link } from "react-router";
import { HullDiagram } from "../components/HullDiagram";
import { Wordmark } from "../components/Mark";

const REPO = (import.meta.env.VITE_REPO_URL as string | undefined) || "https://github.com/opeblow/bulkhead";

const STEPS = [
  {
    n: "01",
    t: "Read",
    d: (
      <>
        Employers send payroll as a CSV, an email or a Slack message. Claude extracts each line and flags
        anything a person should see, such as a contractor whose bank details just changed.
      </>
    ),
  },
  {
    n: "02",
    t: "Seal",
    d: (
      <>
        Each employer's balance is read from its own connected account. Every customer call goes through a
        client that cannot be built without <code>x-on-behalf-of</code>.
      </>
    ),
  },
  {
    n: "03",
    t: "Price",
    d: (
      <>
        Payouts, SWIFT fees and the platform fee are priced in exact integer arithmetic. Fees are counted
        before converting, so the last payout never bounces.
      </>
    ),
  },
  {
    n: "04",
    t: "Decide",
    d: (
      <>
        When an employer is short, code lists the options and policy judges each one. The model recommends
        among the options it is allowed to choose and explains why.
      </>
    ),
  },
  {
    n: "05",
    t: "Pay",
    d: (
      <>
        Every conversion and transfer has a stable <code>request_id</code>. Unclear responses are checked by{" "}
        <code>request_id</code> before any retry. Transfers are followed to PAID or CANCELLED.
      </>
    ),
  },
  {
    n: "06",
    t: "Prove",
    d: (
      <>
        After each run: a double-entry ledger, a reconciliation against Airwallex balances, a check on every
        call's headers, and a tamper-evident audit chain.
      </>
    ),
  },
];

const OPTIONS = [
  {
    o: "Pay Priya now, bridge $1,953 for Jonas",
    p: "Needs approval",
    d: "Platform capital, capped per employer, reserve floor kept. Repaid from Fjord & Pine's next deposit.",
    chosen: true,
  },
  {
    o: "Pay Priya now, wait for a top-up",
    p: "Allowed",
    d: "Uses only Fjord & Pine's own funds. Jonas waits.",
  },
  { o: "Hold the whole batch", p: "Allowed", d: "Nobody is paid today." },
  {
    o: "Cover the gap from Northwind's balance",
    p: "Denied",
    d: "The platform could do this. Policy will not.",
    denied: true,
  },
];

const CHECKS = [
  [
    "Funds stay with their employer",
    "Each employer's balance is read only from its own connected account, and nothing ever adds balances across employers. The ledger rejects any entry that touches two employers.",
  ],
  [
    "x-on-behalf-of on every customer call",
    "Customer calls go through a client that is created per employer. After each run, Bulkhead counts the customer-scoped calls and the headers they sent.",
  ],
  [
    "SWIFT fees counted before FX",
    "The €12.85 SWIFT fee is part of the amount converted. Policy denies any conversion that would leave the batch short.",
  ],
  [
    "Transfer method set explicitly",
    "LOCAL or SWIFT comes from each contractor's record. It is never guessed from whether a fee exists.",
  ],
  [
    "Transfers followed to a final status",
    "Transfers created on a customer's behalf stay PROCESSING until simulated. Bulkhead moves each one to SENT, then PAID or CANCELLED, and polls until it is final.",
  ],
  [
    "CANCELLED handled as a failure",
    "A bank return comes back as CANCELLED with a failure_type. The money goes back to the right wallet, nothing is resent automatically, and a person gets a written explanation.",
  ],
  [
    "No duplicate payouts",
    "Request ids come from the run and the contractor. Unclear failures are checked by request_id before retrying.",
  ],
  [
    "Platform charges polled until settled",
    "Charges and bridge transfers come back NEW. Bulkhead treats only SETTLED as done, and collects fees after contractors are paid.",
  ],
  [
    "Approvals tied to exact terms",
    "Each approval is a SHA-256 digest of the action, employer, amount, counterparty, terms and evidence. If any of them change, the approval no longer applies.",
  ],
  [
    "Webhooks verified",
    "HMAC-SHA256 of the timestamp plus the raw body. Duplicate events are dropped and events are applied in created_at order.",
  ],
];

export function Landing() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 8);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);

  return (
    <div className="site">
      <header className={`nav${scrolled ? " scrolled" : ""}`}>
        <div className="nav-inner">
          <Link to="/" style={{ textDecoration: "none" }}>
            <Wordmark />
          </Link>
          <a className="link" href="#trap">
            The problem
          </a>
          <a className="link" href="#how">
            How it works
          </a>
          <a className="link" href="#decision">
            Decisions
          </a>
          <a className="link" href="#track">
            Track 6 checklist
          </a>
          <span className="spacer" />
          <a className="link" href={REPO}>
            GitHub
          </a>
          <Link className="btn sm" to="/console">
            Open console
          </Link>
        </div>
      </header>

      <main>
        <section className="wrap hero">
          <div>
            <span className="eyebrow">Airwallex Agentic Banking Hackathon · Track 06</span>
            <h1>
              Payroll for many employers.
              <br />
              <em>Money that never mixes.</em>
            </h1>
            <p className="lede">
              Bulkhead is an agent that runs weekly contractor payroll across Airwallex connected accounts. It
              prices, converts and pays each employer only from its own wallet. When an employer comes up
              short, it works out what to do instead of borrowing someone else's money.
            </p>
            <div className="ctas">
              <Link className="btn signal" to="/console">
                Run the live demo
              </Link>
              <a className="btn ghost" href="#track">
                See how each requirement is met
              </a>
            </div>
            <div className="meta">
              <span>Airwallex connected accounts · FX · payouts · charges</span>
              <span>Claude for reading and judgement, code for money</span>
            </div>
          </div>
          <HullDiagram />
        </section>

        <section id="trap" className="section">
          <div className="wrap">
            <div className="section-head">
              <span className="eyebrow">The problem</span>
              <div>
                <h2>Adding up the balances gives the wrong answer.</h2>
                <p>
                  Three employers, one payroll run. Fjord & Pine is short. Mid-run, Kestrel's deposit lands in
                  a different wallet. A naive agent adds the balances together, sees plenty, and reports the
                  batch as covered. Fjord & Pine still can't pay its own contractors.
                </p>
              </div>
            </div>
            <div className="trap">
              <div>
                <span className="fig">A · Northwind</span>
                <div className="big">$24,000</div>
                <span className="muted">needs $11,980.72</span>
              </div>
              <div>
                <span className="fig">B · Fjord & Pine</span>
                <div className="big" style={{ color: "var(--amber)" }}>
                  $6,000
                </div>
                <span className="muted">needs $7,952.83 · short $1,952.83</span>
              </div>
              <div>
                <span className="fig">C · Kestrel Health</span>
                <div className="big">$0 → $15,000</div>
                <span className="muted">deposit lands mid-run</span>
              </div>
              <div>
                <span className="fig">Sum of all wallets</span>
                <div className="big struck">$45,000</div>
                <span className="muted">
                  Never used for a funding decision. Each employer is checked against its own wallet only.
                </span>
              </div>
            </div>
          </div>
        </section>

        <section id="how" className="section">
          <div className="wrap">
            <div className="section-head">
              <span className="eyebrow">How it works</span>
              <div>
                <h2>The model reads and recommends. Code moves the money.</h2>
                <p>
                  Following Airwallex's own guidance: amounts, limits, checks, duplicate protection and status
                  changes are in code. Claude reads unstructured messages, compares options and explains
                  exceptions. It only gets typed results, never credentials.
                </p>
              </div>
            </div>
            <div className="steps">
              {STEPS.map((s) => (
                <article className="step" key={s.n}>
                  <span className="n">{s.n}</span>
                  <h3>{s.t}</h3>
                  <p>{s.d}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="decision" className="section">
          <div className="wrap">
            <div className="section-head">
              <span className="eyebrow">Inside a decision</span>
              <div>
                <h2>Four options. One is off the table.</h2>
                <p>
                  Fjord & Pine holds $6,000 against $7,952.83. Code works out what each option would cost and
                  policy rules on each one before the model sees them. The cross-employer option is shown to
                  everyone, including the model, as denied. Platform capital can be lent, but only with a
                  person's approval, up to a per-employer cap, and above a reserve floor.
                </p>
              </div>
            </div>
            <table className="options-table">
              <thead>
                <tr>
                  <th style={{ width: "30%" }}>Option</th>
                  <th style={{ width: "16%" }}>Policy</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {OPTIONS.map((o) => (
                  <tr key={o.o} className={o.denied ? "denied" : o.chosen ? "chosen" : ""}>
                    <td>
                      <b style={{ fontWeight: 500 }}>{o.o}</b>
                      {o.chosen && (
                        <div style={{ marginTop: 6 }}>
                          <span className="chip good">
                            <span className="dot" /> Recommended
                          </span>
                        </div>
                      )}
                    </td>
                    <td>
                      <span className={`chip ${o.denied ? "bad" : o.p === "Needs approval" ? "steel" : ""}`}>
                        {o.p}
                      </span>
                    </td>
                    <td className="muted">{o.d}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section id="track" className="section">
          <div className="wrap">
            <div className="section-head">
              <span className="eyebrow">Track 6 checklist</span>
              <div>
                <h2>Every warning in the brief, handled in code.</h2>
                <p>
                  Each item below is a warning from the Airwallex Track 6 builder guide. Each is backed by a
                  test you can run: <span className="mono">pnpm test</span>.
                </p>
              </div>
            </div>
            <div className="checklist">
              {CHECKS.map(([b, p]) => (
                <div className="check" key={b}>
                  <span className="tick">✓</span>
                  <div>
                    <b>{b}</b>
                    <p>{p}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="cta-band">
          <div className="wrap">
            <span className="eyebrow">
              Live demo · runs against a faithful sandbox simulator or the real Airwallex sandbox
            </span>
            <h2>Run payroll for three employers.</h2>
            <Link className="btn signal" to="/console">
              Open the console
            </Link>
          </div>
        </section>
      </main>

      <footer className="footer">
        <div className="wrap">
          <span>Bulkhead · Apache-2.0 · Built for the Airwallex Agentic Banking Hackathon 2026</span>
          <span>Sandbox only. Synthetic people and accounts. No real money moves.</span>
        </div>
      </footer>
    </div>
  );
}
