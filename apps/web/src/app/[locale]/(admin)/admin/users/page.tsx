import { AdminUsers } from "@/components/admin/users";
import { titled } from "@/i18n/server";

export const generateMetadata = titled((m) => `${m.admin.nav.users} · ${m.admin.title}`);

export default function AdminUsersPage() {
  return <AdminUsers />;
}
