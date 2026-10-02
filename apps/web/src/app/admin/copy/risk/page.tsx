import { AdminCopyRisk } from "@/components/admin/copy/risk";
import { titled } from "@/i18n/server";

export const generateMetadata = titled((m) => `${m.copyAdmin.nav.risk} · ${m.copyAdmin.nav.title} · ${m.admin.title}`);

export default function AdminCopyRiskPage() {
  return <AdminCopyRisk />;
}
