"use client";

import { queryKeys } from "@/lib/query-keys";
import { useQuery } from "@tanstack/react-query";
import type { ActionFeedItem, ActionKind, Fill } from "@/lib/contracts";
import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { Fragment, useState } from "react";
import { cn } from "cn";

import { AddressAvatar } from "@/components/traders/address-avatar";
import { CoinIcon } from "@/components/traders/coin-icon";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useI18n } from "@/i18n/provider";
import { api } from "@/lib/api";
import { TraderName } from "@/components/traders/trader-name";
import { coinLabel, toNumber } from "@/lib/format";

export const ACTION_KINDS: readonly ActionKind[] = ["open", "add", "reduce", "close", "flip", "liquidation"];

const KIND_STYLE: Record<ActionKind, string> = {
  open: "bg-tag-alert text-tag-alert-foreground",
  add: "bg-tag-alert text-tag-alert-foreground",
  reduce: "bg-raised text-muted-foreground",
  close: "bg-raised text-foreground",
  flip: "bg-warning/12 text-warning",
  liquidation: "bg-tag-loss text-tag-loss-foreground",
};

export function KindBadge({ kind }: { kind: ActionKind }) {
  const { t } = useI18n();
  return (
    <span className={cn("inline-flex h-6 items-center rounded-full px-2 text-xs font-semibold", KIND_STYLE[kind])}>
      {t(`actions.kinds.${kind}`)}
    </span>
  );
}

export function SideText({ side }: { side: string }) {
  const { t } = useI18n();
  const long = side === "long" || side === "buy" || side === "B";
  return (
    <span className={cn("font-semibold", long ? "text-positive" : "text-negative")}>
      {long ? t("common.long") : t("common.short")}
    </span>
  );
}

/** Live action rows (D1). Each row can expand to the fills behind it. */
export function ActionsTable({
  rows,
  showTrader = true,
  expandable = true,
  highlight,
}: {
  rows: ActionFeedItem[];
  showTrader?: boolean;
  expandable?: boolean;
  /** Ids of rows that just arrived live; they flash briefly. */
  highlight?: ReadonlySet<string>;
}) {
  const { t, format } = useI18n();
  const [expanded, setExpanded] = useState<string | null>(null);
  const colSpan = showTrader ? 8 : 7;

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>{t("actions.cols.time")}</TableHead>
          {showTrader ? <TableHead>{t("actions.cols.trader")}</TableHead> : null}
          <TableHead>{t("actions.cols.coin")}</TableHead>
          <TableHead>{t("actions.cols.action")}</TableHead>
          <TableHead>{t("actions.cols.side")}</TableHead>
          <TableHead className="text-right">{t("actions.cols.notional")}</TableHead>
          <TableHead className="hidden text-right sm:table-cell">{t("actions.cols.leverage")}</TableHead>
          <TableHead className="hidden text-right md:table-cell">{t("actions.cols.price")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const id = String(row.id);
          const open = expanded === id;
          const leverage = toNumber(row.leverage);
          return (
            <Fragment key={id}>
              <TableRow
                className={cn(expandable && "cursor-pointer", highlight?.has(id) && "row-arrive")}
                data-live={highlight?.has(id) ? "new" : undefined}
                onClick={expandable ? () => setExpanded(open ? null : id) : undefined}
              >
                <TableCell className="text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    {expandable ? (
                      <button type="button" aria-expanded={open} aria-label={`${t(open ? "common.collapse" : "common.expand")} ${coinLabel(row.coin)} ${format.dateTime(row.ts)}`} onClick={e => { e.stopPropagation(); setExpanded(open ? null : id); }} className="rounded p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      <ChevronDown aria-hidden="true"
                        className={cn("size-3.5 text-subtle-foreground transition-transform", open && "rotate-180")}
                      /></button>
                    ) : null}
                    <span className="num font-mono text-xs" title={format.dateTime(row.ts)}>{format.relative(row.ts)}</span>
                  </span>
                </TableCell>
                {showTrader ? (
                  <TableCell>
                    <Link
                      href={`/trader/${row.address}`}
                      onClick={(e) => e.stopPropagation()}
                      className="flex items-center gap-2 rounded-md font-medium outline-none hover:text-primary-text focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <AddressAvatar seed={row.address} size={22} />
                      <span className="flex max-w-[9rem] min-w-0">
                        <TraderName trader={{ address: row.address, displayName: row.leaderLabel }} />
                      </span>
                      {row.leaderTier ? (
                        <span className="rounded-md bg-raised px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                          {row.leaderTier}
                        </span>
                      ) : null}
                    </Link>
                  </TableCell>
                ) : null}
                <TableCell>
                  <span className="flex items-center gap-2 font-semibold">
                    <CoinIcon coin={row.coin} size={20} />
                    {coinLabel(row.coin)}
                  </span>
                </TableCell>
                <TableCell>
                  <KindBadge kind={row.kind} />
                </TableCell>
                <TableCell>
                  <SideText side={row.side} />
                </TableCell>
                <TableCell className="text-right font-semibold">
                  {format.usd(row.notionalUsd, { compact: true })}
                </TableCell>
                <TableCell className="hidden text-right text-muted-foreground sm:table-cell">
                  {leverage ? `${format.num(leverage, 1)}×` : "—"}
                </TableCell>
                <TableCell className="hidden text-right text-muted-foreground md:table-cell">
                  {format.price(row.avgPx)}
                </TableCell>
              </TableRow>
              {open ? <FillsRow actionId={id} colSpan={colSpan} /> : null}
            </Fragment>
          );
        })}
      </TableBody>
    </Table>
  );
}

function FillsRow({ actionId, colSpan }: { actionId: string; colSpan: number }) {
  const { t, format } = useI18n();
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.actions.fills(actionId),
    queryFn: ({ signal }) => api.get<Fill[]>(`/actions/${actionId}/fills`, signal),
    refetchInterval: false,
  });

  return (
    <TableRow className="bg-background/40 hover:bg-background/40">
      <TableCell colSpan={colSpan} className="px-5 py-3 whitespace-normal">
        {isLoading ? <span className="text-xs text-muted-foreground">{t("actions.loadingFills")}</span> : null}
        {data && data.length === 0 ? (
          <span className="text-xs text-muted-foreground">{t("actions.noFills")}</span>
        ) : null}
        {data && data.length > 0 ? (
          <div className="overflow-x-auto rounded-xl">
            <table className="num w-full text-xs">
              <thead>
                <tr className="text-left text-subtle-foreground">
                  <th className="px-3 py-2 font-medium">{t("actions.fills.time")}</th>
                  <th className="px-3 py-2 font-medium">{t("actions.fills.dir")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("actions.fills.price")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("actions.fills.size")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("actions.fills.fee")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("actions.fills.closedPnl")}</th>
                </tr>
              </thead>
              <tbody>
                {data.map((fill) => {
                  const pnl = toNumber(fill.closedPnl);
                  return (
                    <tr key={String(fill.tid)} className="border-t border-border/60">
                      <td className="num px-3 py-1.5 font-mono text-muted-foreground">{format.time(fill.ts)}</td>
                      <td className="px-3 py-1.5">{fill.dir}</td>
                      <td className="px-3 py-1.5 text-right">{format.price(fill.px)}</td>
                      <td className="px-3 py-1.5 text-right">{format.num(fill.sz, 4)}</td>
                      <td className="px-3 py-1.5 text-right text-muted-foreground">{format.usd(fill.fee)}</td>
                      <td
                        className={cn(
                          "px-3 py-1.5 text-right",
                          pnl ? (pnl > 0 ? "text-positive" : "text-negative") : "text-muted-foreground",
                        )}
                      >
                        {pnl ? format.usd(pnl, { sign: true }) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </TableCell>
    </TableRow>
  );
}
