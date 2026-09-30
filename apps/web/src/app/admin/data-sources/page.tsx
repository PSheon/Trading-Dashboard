import { AdminSourcesView } from "@/components/admin/data-sources";
import { titled } from "@/i18n/server";
export const generateMetadata = titled(
  (m) => `${m.sources.title} · ${m.admin.title}`,
);
export default function Page() {
  return <AdminSourcesView />;
}
