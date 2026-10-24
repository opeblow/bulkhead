import { Link, NavLink, Outlet, useOutletContext } from "react-router";
import { Wordmark } from "../../components/Mark";
import { type Snapshot, useSnapshot } from "../../lib/api";

export interface ConsoleContext {
  snap: Snapshot | null;
  connected: boolean;
}

export function useConsole(): ConsoleContext {
  return useOutletContext<ConsoleContext>();
}

export function Shell() {
  const { snap, connected } = useSnapshot();
  const pending = snap?.approvals.filter((a) => a.status === "pending").length ?? 0;
  const items = [
    { to: "/console", label: "Payroll run", end: true },
    { to: "/console/approvals", label: "Approvals", badge: pending },
    { to: "/console/ledger", label: "Ledger" },
    { to: "/console/trace", label: "API trace" },
    { to: "/console/audit", label: "Audit chain" },
    { to: "/console/intake", label: "Intake lab" },
  ];
  return (
    <div className="console">
      <aside className="sidebar">
        <Link to="/" style={{ textDecoration: "none", padding: "4px 6px" }}>
          <Wordmark />
        </Link>
        <nav aria-label="Console">
          {items.map((i) => (
            <NavLink
              key={i.to}
              to={i.to}
              end={i.end}
              className={({ isActive }) => (isActive ? "active" : "")}
            >
              <span>{i.label}</span>
              {i.badge ? <span className="count">{i.badge}</span> : null}
            </NavLink>
          ))}
        </nav>
        <div className="foot">
          <span className="fig">Environment</span>
          <span className={`chip ${snap?.mode.airwallex === "sandbox" ? "good" : "steel"}`}>
            <span className="dot" />
            Airwallex {snap?.mode.airwallex === "sandbox" ? "sandbox" : "simulator"}
          </span>
          <span className={`chip ${snap?.mode.advisor === "claude" ? "good" : ""}`}>
            <span className="dot" />
            {snap?.mode.advisor === "claude" ? `Claude · ${snap.mode.model}` : "Rule-based advisor"}
          </span>
          <span className="chip">
            {connected ? <span className="live" /> : <span className="dot" />}
            {connected ? "Live" : "Reconnecting"}
          </span>
          <span style={{ marginTop: 6 }}>Sandbox only. Synthetic data.</span>
        </div>
      </aside>
      <div className="main">
        <Outlet context={{ snap, connected } satisfies ConsoleContext} />
      </div>
    </div>
  );
}
