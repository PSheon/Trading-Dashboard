"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { copyOrderStatusEnum, type CopyOrderStatus } from "@trading-dashboard/shared/contracts";

import { ErrorState, Panel, Skeleton } from "@/components/page";
import { useI18n } from "@/i18n/provider";
import { useAdminCopyOrders } from "@/lib/admin-copy";
import { CopyAdminNav, OrdersTable } from "./shared";

const FAILED: readonly CopyOrderStatus[] = ["rejected", "cancelled"];
const selectClass = "h-10 rounded-full bg-raised px-4 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring";

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
    <div className="flex flex-col gap-4">
      <CopyAdminNav />
      <div className="flex flex-wrap items-center gap-2.5">
        <select
          aria-label={t("copyAdmin.orders.filter")}
          value={filter}
          onChange={(e) => router.replace(e.target.value ? `/admin/copy/orders?status=${e.target.value}` : "/admin/copy/orders")}
          className={selectClass}
        >
          <option value="">{t("copyAdmin.orders.all")}</option>
          <option value="failed">{t("copyAdmin.orders.failed")}</option>
          {copyOrderStatusEnum.map((s) => <option key={s} value={s}>{t(`copyAdmin.orderStatus.${s}`)}</option>)}
        </select>
        {items ? <span className="num ml-auto text-xs text-muted-foreground">{t("copyAdmin.orders.count", { count: items.length })}</span> : null}
      </div>
      <Panel className="overflow-hidden">
        {orders.isError && !items ? <ErrorState message={orders.error.message} onRetry={() => orders.refetch()} />
          : !items ? <Skeleton className="m-5 h-64" />
          : items.length === 0 ? <p className="p-5 text-sm text-muted-foreground">{t("copyAdmin.orders.empty")}</p>
          : <OrdersTable items={items} />}
      </Panel>
    </div>
  );
}
