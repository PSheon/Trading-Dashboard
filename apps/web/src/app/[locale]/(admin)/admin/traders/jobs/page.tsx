import { Suspense } from "react";

import { AdminTraderData } from "@/components/admin/trader-data";
import { titled } from "@/i18n/server";

export const generateMetadata = titled((m) => `${m.admin.sub.jobs} · ${m.admin.nav.traderData} · ${m.admin.title}`);

export default function AdminTraderJobsPage() {
  return (
    <Suspense>
      <AdminTraderData view="jobs" />
    </Suspense>
  );
}
