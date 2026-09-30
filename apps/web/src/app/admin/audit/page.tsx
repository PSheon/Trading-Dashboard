import { AdminAudit } from "@/components/admin/audit";
import { titled } from "@/i18n/server";
export const generateMetadata = titled(m => `${m.settingsOps.audit} · ${m.admin.title}`);
export default function AdminAuditPage() { return <AdminAudit />; }
