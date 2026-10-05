import { AdminShell } from "@/components/admin/admin-shell";
import { titled } from "@/i18n/server";

/** The back office is never indexed (robots.ts also disallows /admin). */
export async function generateMetadata() {
  return { ...(await titled((m) => m.admin.title)()), robots: { index: false, follow: false } };
}

export default function AdminLayout({ children }: LayoutProps<"/[locale]/admin">) {
  return <AdminShell>{children}</AdminShell>;
}
