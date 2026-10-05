import { AdminAudit } from "@/components/admin/audit";
import { titled } from "@/i18n/server";

export const generateMetadata = titled((m) => `${m.admin.sub.audit} · ${m.admin.nav.users} · ${m.admin.title}`);

export default function AdminAuditPage() {
  return <AdminAudit />;
}
