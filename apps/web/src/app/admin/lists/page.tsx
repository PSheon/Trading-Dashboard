import { AdminLists } from "@/components/admin/lists";
import { titled } from "@/i18n/server";

export const generateMetadata = titled((m) => `${m.admin.nav.lists} · ${m.admin.title}`);

export default function AdminListsPage() {
  return <AdminLists />;
}
