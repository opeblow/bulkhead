import { Route, Routes } from "react-router";
import { ApprovalsPage } from "./pages/console/ApprovalsPage";
import { AuditPage } from "./pages/console/AuditPage";
import { IntakePage } from "./pages/console/IntakePage";
import { LedgerPage } from "./pages/console/LedgerPage";
import { RunPage } from "./pages/console/RunPage";
import { Shell } from "./pages/console/Shell";
import { TracePage } from "./pages/console/TracePage";
import { Landing } from "./pages/Landing";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/console" element={<Shell />}>
        <Route index element={<RunPage />} />
        <Route path="approvals" element={<ApprovalsPage />} />
        <Route path="ledger" element={<LedgerPage />} />
        <Route path="trace" element={<TracePage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="intake" element={<IntakePage />} />
      </Route>
      <Route path="*" element={<Landing />} />
    </Routes>
  );
}
