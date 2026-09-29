import { AdminRevenue } from "@/components/admin/revenue";
import { titled } from "@/i18n/server";

export const generateMetadata = titled((m) => `${m.admin.nav.revenue} · ${m.admin.title}`);

export default function AdminRevenuePage() {
  return <AdminRevenue />;
}
