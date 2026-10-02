import { AdminCopyOverview } from "@/components/admin/copy/overview";
import { titled } from "@/i18n/server";

export const generateMetadata = titled((m) => `${m.copyAdmin.nav.title} · ${m.admin.title}`);

export default function AdminCopyPage() {
  return <AdminCopyOverview />;
}
