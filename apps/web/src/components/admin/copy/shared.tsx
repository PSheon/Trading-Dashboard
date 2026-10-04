"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "cn";
import type { CopyControlCommand, CopyOrderStatus, CopyStrategyStatus } from "@trading-dashboard/shared/contracts";

import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { MessageKey } from "@/i18n/messages";
import { useI18n } from "@/i18n/provider";
import { copyReasonText } from "@/lib/admin-copy";
import { usePermission } from "@/lib/auth";
import type { AdminCopyOrderView } from "@/lib/contracts";
import { coinLabel } from "@/lib/format";

const PAGES: { href: string; label: MessageKey }[] = [
  { href: "/admin/copy", label: "copyAdmin.nav.overview" },
  { href: "/admin/copy/strategies", label: "copyAdmin.nav.strategies" },
  { href: "/admin/copy/users", label: "copyAdmin.nav.users" },
  { href: "/admin/copy/orders", label: "copyAdmin.nav.orders" },
  { href: "/admin/copy/risk", label: "copyAdmin.nav.risk" },
  { href: "/admin/copy/live", label: "copyAdmin.nav.live" },
];

/** The copy admin's own pages, under the admin section tabs. */
export function CopyAdminNav() {
  const { t } = useI18n();
  const pathname = usePathname();
  return (
    <nav aria-label={t("copyAdmin.nav.title")} className="-mx-4 flex gap-1.5 overflow-x-auto px-4 no-scrollbar md:mx-0 md:px-0">
      {PAGES.map((page) => {
        const active = page.href === "/admin/copy" ? pathname === page.href : pathname.startsWith(page.href);
        return (
          <Link
            key={page.href}
            href={page.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "shrink-0 rounded-full px-3.5 py-1.5 text-[0.8125rem] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active ? "bg-raised text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t(page.label)}
          </Link>
        );
      })}
    </nav>
  );
}

export function Chip({ tone = "neutral", children }: { tone?: "neutral" | "good" | "bad" | "warn" | "info"; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap",
        tone === "good" && "bg-positive-soft text-positive",
        tone === "bad" && "bg-negative-soft text-negative",
        tone === "warn" && "bg-warning/15 text-warning",
        tone === "info" && "bg-primary-soft text-primary",
        tone === "neutral" && "bg-raised text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

/** Stop state of one level: running, or the flags that are set. */
export function ControlState({ state }: { state: { pauseNewRisk: boolean; reduceOnly: boolean } }) {
  const { t } = useI18n();
  if (!state.pauseNewRisk && !state.reduceOnly) return <Chip tone="good">{t("copyAdmin.state.running")}</Chip>;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {state.pauseNewRisk ? <Chip tone="bad">{t("copyAdmin.state.paused")}</Chip> : null}
      {state.reduceOnly ? <Chip tone="warn">{t("copyAdmin.state.reduceOnly")}</Chip> : null}
    </span>
  );
}

const STRATEGY_TONE: Record<CopyStrategyStatus, "good" | "warn" | "neutral"> = { active: "good", paused: "warn", stopping: "warn", stopped: "neutral" };
export function StrategyStatus({ status }: { status: CopyStrategyStatus }) {
  const { t } = useI18n();
  return <Chip tone={STRATEGY_TONE[status]}>{t(`copyAdmin.strategyStatus.${status}`)}</Chip>;
}

const ORDER_TONE: Partial<Record<CopyOrderStatus, "good" | "bad" | "warn">> = { filled: "good", partial: "warn", rejected: "bad", cancelled: "warn", unknown: "bad" };
export function OrderStatus({ status }: { status: CopyOrderStatus }) {
  const { t } = useI18n();
  return <Chip tone={ORDER_TONE[status] ?? "neutral"}>{t(`copyAdmin.orderStatus.${status}`)}</Chip>;
}

/** The stop commands and resume, each offered only with its permission. */
export function ControlButtons({ state, onPick, size = "sm" }: {
  state: { pauseNewRisk: boolean; reduceOnly: boolean };
  onPick: (command: CopyControlCommand) => void;
  size?: "xs" | "sm";
}) {
  const { t } = useI18n();
  const canPause = usePermission("execution.pause");
  const canResume = usePermission("execution.resume");
  const stopped = state.pauseNewRisk || state.reduceOnly;
  return (
    <div className="flex flex-wrap gap-1.5">
      <Button variant="secondary" size={size} disabled={!canPause || state.pauseNewRisk} onClick={() => onPick("pause_new_risk")}>{t("copyAdmin.commands.pause_new_risk")}</Button>
      <Button variant="secondary" size={size} disabled={!canPause || state.reduceOnly} onClick={() => onPick("reduce_only")}>{t("copyAdmin.commands.reduce_only")}</Button>
      <Button variant="secondary" size={size} disabled={!canPause} onClick={() => onPick("cancel_pending")}>{t("copyAdmin.commands.cancel_pending")}</Button>
      <Button variant="destructive" size={size} disabled={!canPause} onClick={() => onPick("close_positions")}>{t("copyAdmin.commands.close_positions")}</Button>
      <Button variant="outline" size={size} disabled={!canResume || !stopped} onClick={() => onPick("resume")}>{t("copyAdmin.commands.resume")}</Button>
    </div>
  );
}

/** Paper orders with the reason a rejected or cancelled one was refused. */
export function OrdersTable({ items, showUser = true }: { items: AdminCopyOrderView[]; showUser?: boolean }) {
  const { t, format } = useI18n();
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>{t("copyAdmin.cols.time")}</TableHead>
          {showUser ? <TableHead className="hidden md:table-cell">{t("copyAdmin.cols.user")}</TableHead> : null}
          <TableHead>{t("copyAdmin.cols.order")}</TableHead>
          <TableHead className="hidden text-right sm:table-cell">{t("copyAdmin.cols.size")}</TableHead>
          <TableHead>{t("copyAdmin.cols.status")}</TableHead>
          <TableHead className="hidden sm:table-cell">{t("copyAdmin.cols.reason")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((o) => (
          <TableRow key={o.id}>
            <TableCell className="whitespace-nowrap text-muted-foreground">{format.dateTime(o.createdAt)}</TableCell>
            {showUser ? <TableCell className="hidden max-w-[12rem] truncate md:table-cell">{o.userEmail ?? `#${o.userId}`}</TableCell> : null}
            <TableCell className="whitespace-nowrap">
              <Link href={`/admin/copy/strategies/${o.strategyId}`} className="font-semibold underline decoration-border underline-offset-4">
                {coinLabel(o.coin)}
              </Link>{" "}
              <span className={o.side === "B" ? "text-positive" : "text-negative"}>{t(o.side === "B" ? "common.buy" : "common.sell")}</span>{" "}
              <span className="text-subtle-foreground">{t(`copyAdmin.leg.${o.leg}`)}</span>
              {/* Phones: the reason sits under the order instead of in a column scrolled out of view. */}
              {o.status === "filled" || !o.reason ? null : <span className="mt-1 block whitespace-normal text-xs text-muted-foreground sm:hidden">{copyReasonText(o.reason, t)}</span>}
            </TableCell>
            <TableCell className="hidden text-right sm:table-cell">{format.num(o.size, 5)}</TableCell>
            <TableCell><OrderStatus status={o.status} /></TableCell>
            <TableCell className="hidden min-w-[10rem] text-muted-foreground sm:table-cell">{o.status === "filled" ? "—" : copyReasonText(o.reason, t)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
