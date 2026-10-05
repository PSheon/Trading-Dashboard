import { Suspense } from "react";

import { AdminCopyStatus } from "@/components/admin/copy/status";
import { titled } from "@/i18n/server";

export const generateMetadata = titled((m) => `${m.admin.nav.copy} · ${m.admin.title}`);

export default function AdminCopyPage() {
  // ?strategy= opens that copy's ledger (useSearchParams needs a Suspense boundary).
  return (
    <Suspense>
      <AdminCopyStatus />
    </Suspense>
  );
}
