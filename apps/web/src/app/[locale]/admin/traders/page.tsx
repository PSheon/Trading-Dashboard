import { Suspense } from "react";

import { AdminTraderData } from "@/components/admin/trader-data";
import { titled } from "@/i18n/server";

export const generateMetadata = titled((m) => `${m.admin.nav.traderData} · ${m.admin.title}`);

export default function AdminTradersPage() {
  // ?address= opens that address's diagnosis (useSearchParams needs a Suspense boundary).
  return (
    <Suspense>
      <AdminTraderData view="kols" />
    </Suspense>
  );
}
