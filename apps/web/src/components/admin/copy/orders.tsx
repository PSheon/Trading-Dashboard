"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { copyOrderStatusEnum, type CopyOrderStatus } from "@trading-dashboard/shared/contracts";

import { ErrorState } from "@/components/page";
import { useI18n } from "@/i18n/provider";
import { useAdminCopyOrders } from "@/lib/admin-copy";
import { OrdersTable } from "./shared";
import { AdminSubTabs } from "@/components/admin/admin-shell";
import { COPY_SUB_TABS } from "./status";
import { Select } from "@/components/ui/select";
import { TableSkeleton } from "@/components/ui/table-skeleton";

const FAILED: readonly CopyOrderStatus[] = ["rejected", "cancelled"];

/** Paper orders across every user, newest first. `?status=failed` is the
 * rejected and cancelled ones: the list an operator reads reasons from. */
export function AdminCopyOrders() {
  const { t } = useI18n();
  const router = useRouter();
  const raw = useSearchParams().get("status") ?? "";
  const filter = raw === "failed" || (copyOrderStatusEnum as readonly string[]).includes(raw) ? (raw as CopyOrderStatus | "failed") : "";
  const orders = useAdminCopyOrders({ status: filter === "failed" ? FAILED : filter ? [filter] : undefined });
  const items = orders.data?.items;
  return (
    <div className="flex flex-col gap-5">
      <AdminSubTabs tab="copy" labels={COPY_SUB_TABS} />
      <div className="flex flex-wrap items-center gap-2.5">
        <Select
          size="sm"
          label={t("copyAdmin.orders.filter")}
          value={filter}
          onValueChange={(value) => router.replace(value ? `/admin/copy/orders?status=${value}` : "/admin/copy/orders")}
          options={[{ value: "", label: t("copyAdmin.orders.all") }, { value: "failed", label: t("copyAdmin.orders.failed") }, ...copyOrderStatusEnum.map((s) => ({ value: s, label: t(`copyAdmin.orderStatus.${s}`) }))]}
        />
        {items ? <span className="num type-caption ml-auto">{t("copyAdmin.orders.count", { count: items.length })}</span> : null}
      </div>
      {orders.isError && !items ? <ErrorState message={orders.error.message} onRetry={() => orders.refetch()} />
        : !items ? <TableSkeleton rows={6} columns={[{}, {}, {}, { right: true }, { right: true }]} />
        : items.length === 0 ? <p className="rounded-[18px] bg-raised px-[18px] py-5 text-sm font-bold text-muted-foreground">{t("copyAdmin.orders.empty")}</p>
        : <OrdersTable items={items} />}
    </div>
  );
}
