import { Suspense } from "react";
import { AdminTraderView } from "@/components/admin/trader-detail";
import { titled } from "@/i18n/server";
export const generateMetadata = titled(
  (m) => `${m.adminTrader.title} · ${m.admin.title}`,
);
export default function Page() {
  return (
    <Suspense>
      <AdminTraderView />
    </Suspense>
  );
}
