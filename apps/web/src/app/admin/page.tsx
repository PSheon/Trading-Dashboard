import { AdminOverview } from "@/components/admin/overview";
import { titled } from "@/i18n/server";

export const generateMetadata = titled((m) => `${m.admin.nav.overview} · ${m.admin.title}`);

export default function AdminOverviewPage() {
  return <AdminOverview />;
}
