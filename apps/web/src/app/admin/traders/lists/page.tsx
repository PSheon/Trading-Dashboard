import { Suspense } from "react";

import { AdminTraderData } from "@/components/admin/trader-data";
import { titled } from "@/i18n/server";

export const generateMetadata = titled((m) => `${m.admin.sub.lists} · ${m.admin.nav.traderData} · ${m.admin.title}`);

export default function AdminTraderListsPage() {
  return (
    <Suspense>
      <AdminTraderData view="lists" />
    </Suspense>
  );
}
