import { AdminSystem } from "@/components/admin/system";
import { titled } from "@/i18n/server";

export const generateMetadata = titled((m) => `${m.admin.nav.system} · ${m.admin.title}`);

export default function AdminSystemPage() {
  return <AdminSystem />;
}
