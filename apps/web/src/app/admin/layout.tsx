import { AdminShell } from "@/components/admin/admin-shell";
import { titled } from "@/i18n/server";

export const generateMetadata = titled((m) => m.admin.title);

export default function AdminLayout({ children }: LayoutProps<"/admin">) {
  return <AdminShell>{children}</AdminShell>;
}
