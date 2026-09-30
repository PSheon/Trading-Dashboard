import { AdminKols } from "@/components/admin/kols";
import { titled } from "@/i18n/server";

export const generateMetadata = titled((m) => `${m.admin.nav.kols} · ${m.admin.title}`);

export default function AdminKolsPage() {
  return <AdminKols />;
}
