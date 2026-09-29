import { AdminSettingsForm } from "@/components/admin/settings-form";
import { titled } from "@/i18n/server";

export const generateMetadata = titled((m) => `${m.admin.nav.settings} · ${m.admin.title}`);

export default function AdminSettingsFormPage() {
  return <AdminSettingsForm />;
}
