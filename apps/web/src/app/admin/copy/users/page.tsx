import { AdminCopyUsers } from "@/components/admin/copy/users";
import { titled } from "@/i18n/server";

export const generateMetadata = titled((m) => `${m.copyAdmin.nav.users} · ${m.copyAdmin.nav.title} · ${m.admin.title}`);

export default function AdminCopyUsersPage() {
  return <AdminCopyUsers />;
}
