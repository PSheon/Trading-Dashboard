import { Suspense } from "react";

import { AdminActivity } from "@/components/admin/activity";
import { titled } from "@/i18n/server";

export const generateMetadata = titled((m) => `${m.admin.nav.activity} · ${m.admin.title}`);

export default function AdminActivityPage() {
  // ?coin= filters the stream (useSearchParams needs a Suspense boundary).
  return (
    <Suspense>
      <AdminActivity />
    </Suspense>
  );
}
