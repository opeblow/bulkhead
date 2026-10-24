import { useState } from "react";
import { api, type Lane, type Line, type Snapshot, STATUS_LABEL, shortAcct, timeOf } from "../../lib/api";
import { useConsole } from "./Shell";

export function RunPage() {
  const { snap } = useConsole();
  const [busy, setBusy] = useState(false);
  const [bankReturn, setBankReturn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = snap?.run ?? null;
  const running = run && run.status !== "complete";

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="topbar">
        <h1>Payroll run</h1>
        {run && <span className="chip mono">{run.id}</span>}
        {run && (
          <span
            className={`pill ${run.status === "complete" ? "complete" : run.status === "waiting" ? "awaiting_approval" : "executing"}`}
          >
            {run.status === "waiting" ? "waiting on people or money" : run.status}
          </span>
        )}
        <span className="spacer" />
        {error && <span className="chip bad">{error}</span>}
        {!running && (
          <label className="toggle">
            <input type="checkbox" checked={bankReturn} onChange={(e) => setBankReturn(e.target.checked)} />
            Simulate a bank return for Lena
          </label>
        )}
        {run?.status === "complete" && snap?.mode.airwallex === "simulator" && (
          <button
            className="btn ghost sm"
            disabled={busy}
            onClick={() => act(() => api.reset())}
            type="button"
          >
            Reset world
          </button>
        )}
        <button
          className="btn signal sm"
          disabled={busy || !!running || !snap?.bootstrapped || run?.status === "complete"}
          onClick={() =>
            act(() => api.startRun({ scriptedDeposit: true, injectBankReturn: bankReturn ? "lena" : null }))
          }
          type="button"
          data-testid="start-run"
        >
          {running ? "Run in progress" : "Start payroll run"}
        </button>
      </div>
      <div className="page">
        {!snap ? (
          <div className="panel empty">Connecting to Bulkhead…</div>
        ) : !run ? (
          <StartCard snap={snap} />
        ) : (
          <div className="run-grid">
            <div style={{ minWidth: 0 }}>
              <Aggregate snap={snap} />
              <div className="hull" data-testid="hull">
                {run.lanes.map((lane, i) => (
                  <Fragment key={lane.tenant} wall={i > 0}>
                    <Compartment lane={lane} />
                  </Fragment>
                ))}
              </div>
              {run.lanes
                .filter((l) => l.shortfall)
                .map((l) => (
                  <Decision key={l.tenant} lane={l} snap={snap} />
                ))}
              {run.lanes.some((l) => l.lines.some((x) => x.failure)) && <Exceptions lanes={run.lanes} />}
              {snap.proofs && <ProofBar snap={snap} />}
            </div>
            <Rail snap={snap} busy={busy} act={act} />
          </div>
        )}
      </div>
    </>
  );
}

function Fragment({ wall, children }: { wall: boolean; children: React.ReactNode }) {
  return (
    <>
      {wall && <div className="wall" aria-hidden="true" />}
      {children}
    </>
  );
}

function StartCard({ snap }: { snap: Snapshot }) {
  return (
    <div className="panel start">
      <div>
        <span className="eyebrow">Week 43 · three employers</span>
        <h2>Three employers, three separate wallets, one payroll run.</h2>
        <p className="muted" style={{ fontSize: 15, maxWidth: "38em" }}>
          Northwind is funded. Fjord & Pine is short. Kestrel Health has nothing yet, and its treasury wire
          will land partway through the run. Start the run and watch Bulkhead pay each employer's contractors
          from that employer's own money.
        </p>
        <p className="faint" style={{ fontSize: 13 }}>
          {snap.bootstrapped
            ? "Three connected accounts are active and funded."
            : "Onboarding connected accounts…"}
        </p>
      </div>
      <div style={{ display: "grid", gap: 10 }}>
        {snap.employers.map((e) => (
          <div
            key={e.tenant}
            className="line"
            style={{ gridTemplateColumns: "auto 1fr auto", alignItems: "center", gap: 12 }}
          >
            <span className="key">{e.key}</span>
            <div>
              <div className="who">{e.shortName}</div>
              <div className="sub mono">{shortAcct(e.tenant)}</div>
            </div>
            <span className="sub">{e.contractors.length} contractors</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Aggregate({ snap }: { snap: Snapshot }) {
  return (
    <div className="aggregate" data-testid="aggregate">
      <span className="fig">Sum of all wallets</span>
      <span className="sum">{snap.naiveAggregate.display}</span>
      <span>Not used for decisions. Each employer below is funded only from its own wallet.</span>
    </div>
  );
}

function Compartment({ lane }: { lane: Lane }) {
  const usd = lane.balances.find((b) => b.currency === "USD");
  const others = lane.balances.filter((b) => b.currency !== "USD" && Number(b.amount) !== 0);
  const q = lane.quote;
  const coverage = q
    ? Math.min(1, Number(q.fundingAvailable.amount) / Math.max(0.01, Number(q.fundingRequired.amount)))
    : 0;
  const done = lane.status === "complete";
  const short = ["short", "awaiting_approval", "awaiting_funds", "partial", "held"].includes(lane.status);
  return (
    <section
      className={`compartment${done ? " done" : short ? " short" : ""}`}
      aria-label={lane.shortName}
      data-testid={`lane-${lane.key}`}
    >
      <div className="head">
        <span className="key">{lane.key}</span>
        <h3>{lane.shortName}</h3>
        <span className={`pill ${lane.status}`} style={{ marginLeft: "auto" }}>
          {STATUS_LABEL[lane.status] ?? lane.status}
        </span>
      </div>
      <div className="acct" title={lane.tenant}>
        x-on-behalf-of · {shortAcct(lane.tenant)}
      </div>

      <div className="wallet">
        <span className="fig">Own wallet</span>
        <div className="usd tabular">{usd?.display ?? "$0.00"}</div>
        {others.length > 0 && (
          <div className="other">
            {others.map((o) => (
              <span key={o.currency}>{o.display}</span>
            ))}
          </div>
        )}
        {q && (
          <>
            <div className={`gauge${q.fundable || done ? "" : " short"}`}>
              <i style={{ width: `${(done ? 1 : coverage) * 100}%` }} />
            </div>
            <div className="gauge-legend">
              <span>needs {q.fundingRequired.display}</span>
              <span style={{ color: q.fundable || done ? "var(--sea)" : "var(--amber)" }}>
                {done
                  ? lane.bridge?.status === "SETTLED" || lane.bridge?.status === "repaid"
                    ? "paid · bridged"
                    : "paid"
                  : q.fundable
                    ? "covered"
                    : `short ${q.shortfall.display}`}
              </span>
            </div>
          </>
        )}
      </div>

      <div className="status-line">{lane.statusText}</div>

      <ul className="lines">
        {lane.lines.map((l) => (
          <LineRow key={l.contractorId} l={l} />
        ))}
        {lane.lines.length === 0 && <li className="sub faint">Waiting for payroll instructions…</li>}
      </ul>

      {(q || lane.fee || lane.bridge) && (
        <dl className="kv">
          {q?.requirements
            .filter((r) => Number(r.transferFees.amount) > 0)
            .map((r) => (
              <Pair key={r.currency} k={`SWIFT fees · ${r.currency} · pre-FX`} v={r.transferFees.display} />
            ))}
          {q && (
            <Pair
              k="Platform fee"
              v={lane.fee ? `${lane.fee.amount.display} · ${lane.fee.status}` : q.platformFee.display}
            />
          )}
          {lane.bridge && <Pair k="Bridge" v={`${lane.bridge.amount.display} · ${lane.bridge.status}`} />}
        </dl>
      )}
    </section>
  );
}

function Pair({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}

function LineRow({ l }: { l: Line }) {
  return (
    <li className={`line ${l.status}`}>
      <span className="who">{l.name}</span>
      <span className="amt">{l.amount.display}</span>
      <span className="sub">
        {l.country} · {l.method}
        {Number(l.fee.amount) > 0 ? ` · fee ${l.fee.display}` : ""}
        {l.note ? ` · ${l.note}` : ""}
      </span>
      <span style={{ textAlign: "right" }}>
        <span className={`pill ${l.status}`}>{STATUS_LABEL[l.status] ?? l.status}</span>
      </span>
    </li>
  );
}

function Decision({ lane, snap }: { lane: Lane; snap: Snapshot }) {
  const sf = lane.shortfall!;
  const chosen = sf.advice?.optionId;
  const source = sf.advice?.source === "claude" ? `Claude · ${snap.mode.model}` : "Rule-based advisor";
  return (
    <section className="panel decision" data-testid="decision">
      <div className="panel-head">
        <h2>
          Decision · {lane.shortName} is short {lane.quote?.shortfall.display}
        </h2>
        <span className="fig">Options worked out in code · judged by policy · recommended by {source}</span>
      </div>
      <div className="panel-body">
        <div className="opts">
          {sf.options.map((o) => (
            <div
              key={o.id}
              className={`opt${o.id === chosen ? " chosen" : ""}${o.policy === "deny" ? " deny" : ""}`}
            >
              <h5>{o.title}</h5>
              <p>{o.description}</p>
              <div className="verdict">
                <span
                  className={`chip ${o.policy === "deny" ? "bad" : o.policy === "require_approval" ? "steel" : "good"}`}
                >
                  {o.policy === "deny"
                    ? "Denied by policy"
                    : o.policy === "require_approval"
                      ? "Needs a person"
                      : "Allowed"}
                </span>
              </div>
              {o.policy === "deny" && <p style={{ marginTop: 8, fontSize: 11.5 }}>{o.policyReasons[0]}</p>}
            </div>
          ))}
        </div>
        {sf.advice && (
          <div className="advice">
            <div className="quote-card">
              <span className="fig">Rationale for the operator</span>
              {sf.advice.rationale}
            </div>
            <div className="quote-card" style={{ borderLeftColor: "var(--steel)" }}>
              <span className="fig">Draft message to {lane.shortName}</span>
              {sf.advice.employerMessage}
            </div>
          </div>
        )}
        {sf.resolution && (
          <p style={{ marginTop: 12, marginBottom: 0 }}>
            <span className="chip good">
              <span className="dot" /> {sf.resolution}
            </span>
          </p>
        )}
      </div>
    </section>
  );
}

function Exceptions({ lanes }: { lanes: Lane[] }) {
  const failed = lanes.flatMap((l) => l.lines.filter((x) => x.failure).map((x) => ({ lane: l, line: x })));
  return (
    <section className="panel" style={{ marginTop: 20 }}>
      <div className="panel-head">
        <h2>Exceptions</h2>
        <span className="chip bad">{failed.length} returned</span>
      </div>
      <div className="panel-body" style={{ display: "grid", gap: 12 }}>
        {failed.map(({ lane, line }) => (
          <div key={line.contractorId} className="quote-card" style={{ borderLeftColor: "var(--flood)" }}>
            <span className="fig">
              {lane.shortName} · {line.name} · CANCELLED · {line.failure?.type}
            </span>
            <div>{line.failure?.summary}</div>
            <ol style={{ margin: "8px 0 0", paddingLeft: 18, color: "var(--ink-2)" }}>
              {line.failure?.nextSteps?.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    </section>
  );
}

function ProofBar({ snap }: { snap: Snapshot }) {
  const p = snap.proofs!;
  const items = [
    {
      ok: p.isolation.ok,
      t: "Funds kept separate",
      d: `${p.isolation.journals} ledger entries, ${p.isolation.violations} touching two employers`,
    },
    {
      ok: p.headerCoverage.ok,
      t: "x-on-behalf-of on every call",
      d: `${p.headerCoverage.tenantCalls - p.headerCoverage.missing} of ${p.headerCoverage.tenantCalls} customer-scoped calls`,
    },
    {
      ok: p.duplicatePayouts.ok,
      t: "No duplicate payouts",
      d: `${p.duplicatePayouts.payouts} payouts, ${p.duplicatePayouts.unique} unique request ids`,
    },
    {
      ok: p.reconciliation.ok,
      t: "Reconciled",
      d: `${p.reconciliation.rows.filter((r) => r.ok).length}/${p.reconciliation.rows.length} wallet balances match the ledger`,
    },
    {
      ok: p.auditChain.ok,
      t: "Audit chain intact",
      d: `${p.auditChain.length} records · head ${p.auditChain.head.slice(0, 10)}…`,
    },
  ];
  return (
    <section className="proofs" data-testid="proofs">
      {items.map((i) => (
        <div className="proof" key={i.t}>
          <span className={`ok${i.ok ? "" : " fail"}`}>{i.ok ? "✓ PASS" : "✗ FAIL"}</span>
          <h4>{i.t}</h4>
          <p>{i.d}</p>
        </div>
      ))}
    </section>
  );
}

function Rail({
  snap,
  busy,
  act,
}: {
  snap: Snapshot;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const pending = snap.approvals.filter((a) => a.status === "pending");
  const fjord = snap.employers.find((e) => e.key === "B");
  const owed = snap.platform.bridgeOutstanding.length > 0;
  return (
    <aside className="rail">
      <section className="panel" data-testid="approvals">
        <div className="panel-head">
          <h2>Waiting on a person</h2>
          <span className={`chip ${pending.length ? "steel" : ""}`}>{pending.length}</span>
        </div>
        <div className="panel-body" style={{ display: "grid", gap: 10 }}>
          {pending.length === 0 && (
            <span className="faint" style={{ fontSize: 13 }}>
              Nothing needs approval right now.
            </span>
          )}
          {pending.map((a) => (
            <article key={a.id} className="approval">
              <span className="fig">{a.tenantName}</span>
              <h4>{a.title}</h4>
              <p>{a.summary}</p>
              <div className="binds">
                <span>amount · {a.subject.amount.display}</span>
                <span>counterparty · {a.subject.counterparty}</span>
                {Object.entries(a.subject.terms)
                  .filter(([, v]) => v)
                  .map(([k, v]) => (
                    <span key={k}>
                      {k} · {v}
                    </span>
                  ))}
                <span>sha256 · {a.digest.slice(0, 24)}…</span>
              </div>
              <div className="actions">
                <button
                  className="btn approve sm"
                  disabled={busy}
                  onClick={() => act(() => api.decide(a.id, "approve"))}
                  type="button"
                  data-testid={`approve-${a.subject.action}`}
                >
                  Approve
                </button>
                <button
                  className="btn reject sm"
                  disabled={busy}
                  onClick={() => act(() => api.decide(a.id, "reject"))}
                  type="button"
                >
                  Reject
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>

      {fjord && (snap.run?.status === "complete" || owed) && (
        <section className="panel">
          <div className="panel-head">
            <h2>Simulate money arriving</h2>
          </div>
          <div className="panel-body" style={{ display: "grid", gap: 8 }}>
            <button
              className="btn ghost sm"
              disabled={busy}
              onClick={() => act(() => api.deposit("B", "3000", "Client invoice cleared"))}
              type="button"
              data-testid="topup-b"
            >
              $3,000 lands in Fjord & Pine's own wallet
            </button>
            <span className="faint" style={{ fontSize: 12 }}>
              {owed
                ? "Bulkhead repays the bridge from Fjord & Pine's own deposit, never from another employer."
                : "Deposits only ever change one employer's wallet."}
            </span>
          </div>
        </section>
      )}

      <section className="panel">
        <div className="panel-head">
          <h2>Timeline</h2>
          <span className="fig">{snap.timeline.length} events</span>
        </div>
        <ol className="timeline" data-testid="timeline">
          {[...snap.timeline].reverse().map((t) => {
            const who = snap.employers.find((e) => e.tenant === t.tenant)?.shortName;
            return (
              <li key={t.id} className={`tl ${t.tone}`}>
                <span className="mark" />
                <div>
                  <div className="t">{t.title}</div>
                  {t.detail && <div className="d">{t.detail}</div>}
                  <div className="when">
                    {timeOf(t.at)} · {who ?? "platform"} · {t.kind}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </section>
    </aside>
  );
}
