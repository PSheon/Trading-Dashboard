import { AdminCopyStrategies } from "@/components/admin/copy/strategies";
import { titled } from "@/i18n/server";

export const generateMetadata = titled((m) => `${m.copyAdmin.nav.strategies} · ${m.copyAdmin.nav.title} · ${m.admin.title}`);

export default function AdminCopyStrategiesPage() {
  return <AdminCopyStrategies />;
}
