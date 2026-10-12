import { AdminCopyLive } from "@/components/admin/copy/live";
import { titled } from "@/i18n/server";

export const generateMetadata = titled((m) => `${m.admin.sub.copyTestnet} · ${m.admin.nav.copy} · ${m.admin.title}`);

export default function AdminCopyTestnetPage() {
  return <AdminCopyLive />;
}
