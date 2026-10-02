import { notFound } from "next/navigation";

import { AdminCopyStrategyDetail } from "@/components/admin/copy/strategies";
import { titled } from "@/i18n/server";

export const generateMetadata = titled((m) => `${m.copyAdmin.nav.strategies} · ${m.copyAdmin.nav.title} · ${m.admin.title}`);

/** A strategy id is a positive int4; anything else is the 404. */
export default async function AdminCopyStrategyPage({ params }: PageProps<"/admin/copy/strategies/[id]">) {
  const { id } = await params;
  if (!/^[1-9]\d{0,9}$/.test(id) || Number(id) > 2_147_483_647) notFound();
  return <AdminCopyStrategyDetail id={Number(id)} />;
}
