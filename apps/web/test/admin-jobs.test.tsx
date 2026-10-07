import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { JobCard } from "@/components/admin/jobs";
import { I18nProvider } from "@/i18n/provider";
import { en } from "@/i18n/messages/en";
import type { BackfillJob } from "@/lib/contracts";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
const job: BackfillJob = {
  id: 1,
  chain: "hyperliquid",
  address: "0x" + "ab".repeat(20),
  source: "import",
  status: "failed",
  attempts: 3,
  runAttempts: 3,
  version: 4,
  availableAt: "2026-09-30T00:00:00Z",
  createdAt: "2026-09-30T00:00:00Z",
  startedAt: null,
  completedAt: null,
  leaseExpiresAt: null,
  fillsFetched: null,
  lastErrorCode: "backfill_failed",
};
const render = (value: BackfillJob, canRetry: boolean) =>
  renderToStaticMarkup(
    <I18nProvider locale="en" messages={en}>
      <JobCard
        job={value}
        canRetry={canRetry}
        busy={false}
        now={Date.parse("2026-09-30T01:00:00Z")}
        onRetry={() => {}}
      />
    </I18nProvider>,
  );
it("offers requeue only to authorized operators on failed jobs", () => {
  expect(render(job, true)).toContain("Requeue");
  expect(render(job, false)).not.toContain("<button");
  expect(render({ ...job, status: "pending" }, true)).not.toContain("<button");
});
it("marks expired running leases as awaiting recovery and keeps unknown fetched count explicit", () => {
  const html = render(
    { ...job, status: "running", leaseExpiresAt: "2026-09-30T00:01:00Z" },
    true,
  );
  expect(html).toContain('data-slot="data-list"');
  expect(html).toContain("Lease expired; awaiting recovery");
  expect(html).toContain("Not reported");
});
