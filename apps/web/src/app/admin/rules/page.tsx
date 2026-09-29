import { AdminRules } from "@/components/admin/rules";
import { titled } from "@/i18n/server";

export const generateMetadata = titled((m) => `${m.admin.nav.rules} · ${m.admin.title}`);

export default function AdminRulesPage() {
  return <AdminRules />;
}
