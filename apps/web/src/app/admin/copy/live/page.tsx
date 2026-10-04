import { AdminCopyLive } from "@/components/admin/copy/live";
import { titled } from "@/i18n/server";

export const generateMetadata = titled((m) => `${m.copyAdmin.nav.live} · ${m.copyAdmin.nav.title} · ${m.admin.title}`);

export default function AdminCopyLivePage() {
  return <AdminCopyLive />;
}
