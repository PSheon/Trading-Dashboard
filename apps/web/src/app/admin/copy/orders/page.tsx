import { Suspense } from "react";

import { AdminCopyOrders } from "@/components/admin/copy/orders";
import { titled } from "@/i18n/server";

export const generateMetadata = titled((m) => `${m.admin.sub.copyOrders} · ${m.admin.nav.copy} · ${m.admin.title}`);

export default function AdminCopyOrdersPage() {
  // ?status= filters the list (useSearchParams needs a Suspense boundary).
  return (
    <Suspense>
      <AdminCopyOrders />
    </Suspense>
  );
}
