import { AdminJobs } from "@/components/admin/jobs";
import { titled } from "@/i18n/server";
export const generateMetadata = titled(
  (m) => `${m.jobs.title} · ${m.admin.title}`,
);
export default function AdminJobsPage() {
  return <AdminJobs />;
}
