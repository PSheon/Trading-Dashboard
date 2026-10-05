"use client";

import Link from "next/link";
import { cn } from "cn";
import type { CopyControlCommand, CopyOrderStatus, CopyStrategyStatus } from "@trading-dashboard/shared/contracts";

import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useI18n } from "@/i18n/provider";
import { copyReasonText } from "@/lib/admin-copy";
import { usePermission } from "@/lib/auth";
import type { AdminCopyOrderView } from "@/lib/contracts";
import { coinLabel } from "@/lib/format";

export function Chip({ tone = "neutral", children }: { tone?: "neutral" | "good" | "bad" | "warn" | "info"; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "chip-sm",
        tone === "good" && "bg-tag-profit text-tag-profit-foreground",
        tone === "bad" && "bg-tag-loss text-tag-loss-foreground",
        tone === "warn" && "bg-tag-warning text-tag-warning-foreground",
        tone === "info" && "bg-tag-alert text-tag-alert-foreground",
        tone === "neutral" && "bg-(--seg-track,var(--raised)) text-muted-foreground",
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
  size?: "sm" | "default";
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
      <Button variant="default" size={size} disabled={!canResume || !stopped} onClick={() => onPick("resume")}>{t("copyAdmin.commands.resume")}</Button>
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
              <Link href={`/admin/copy?strategy=${o.strategyId}`} className="font-semibold underline decoration-border underline-offset-4">
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
