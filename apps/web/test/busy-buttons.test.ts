import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { auditBusyButtons } from "./busy-audit";

/**
 * Every button that starts async work shows it is busy (Paul, 2026-10-06).
 *
 * How: the type checker reads every component and page (test/busy-audit.ts)
 * instead of rendering each with a pending mutation. Rendering would need
 * fixtures for ~40 components and still only cover the states someone
 * thought to render; reading the handlers covers every pressable, including
 * ones added later. A pressable fails when its handler (or what it calls,
 * across files) awaits, calls `mutate`/`mutateAsync` or returns a Promise,
 * and it has no `loading` (Button), `busy` (TextButton) or `aria-busy`.
 */

/** Files still to be done in this stream (removed as each lands). */
const PENDING = new Set<string>([
  "components/admin/audit.tsx",
  "components/admin/copy/control-dialog.tsx",
  "components/admin/copy/live.tsx",
  "components/admin/copy/risk.tsx",
  "components/admin/jobs.tsx",
  "components/admin/kol-import.tsx",
  "components/admin/kols.tsx",
  "components/admin/lists.tsx",
  "components/admin/monitoring.tsx",
  "components/admin/settings-form.tsx",
  "components/admin/unresolved-withdrawals.tsx",
  "components/alerts/alert-bell.tsx",
  "components/favorites/favorites-view.tsx",
  "components/favorites/groups.tsx",
  "components/insights/insights-view.tsx",
  "components/settings/bot-rows.tsx",
  "components/settings/delete-account.tsx",
  "components/settings/referral.tsx",
  "components/settings/settings-view.tsx",
  "components/shell/account-controls.tsx",
  "components/trader/share-dialog.tsx",
  "components/trader/trade-analytics.tsx",
  "components/trader/trade-share-dialog.tsx",
  "components/trader/trader-view.tsx",
  "components/wallet/deposit-dialog.tsx",
  "components/wallet/export-key-dialog.tsx",
  "components/wallet/funds-history.tsx",
  "components/wallet/withdraw-dialog.tsx",
]);

describe("busy buttons", () => {
  const findings = auditBusyButtons();

  it("every async action's pressable shows it is busy", () => {
    const missing = findings.filter((finding) => !PENDING.has(finding.file)).map((f) => `${f.file}:${f.line} <${f.tag}> ${f.handler.replace(/\s+/g, " ")}`);
    expect(missing).toEqual([]);
  });

  it("reports a fixture's missing busy states and nothing else (the audit itself works)", () => {
    const fixture = auditBusyButtons(join(__dirname, "fixtures/busy"));
    const lines = fixture.map((finding) => finding.line).sort((a, b) => a - b);
    // bad-mutate, bad-await, bad-indirect, bad-refetch, bad-plain, bad-submit
    expect(lines).toEqual([17, 18, 19, 20, 21, 22]);
  });

  it("keeps the list of files still to do honest", () => {
    // These files are known to start async work from a pressable; if the
    // audit stops seeing them it has broken, not the files improved.
    const seen = new Set(findings.map((finding) => finding.file));
    for (const file of PENDING) if (!seen.has(file)) throw new Error(`${file} is done: remove it from PENDING`);
  });
}, 120_000);
