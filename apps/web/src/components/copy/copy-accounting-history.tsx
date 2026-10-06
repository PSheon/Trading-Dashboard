"use client";

import { copyRecordLabel } from "./copy-labels";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { wireCopyLedgerSchema, wireCopyFillsSchema } from "@trading-dashboard/shared/contracts";
import { useI18n } from "@/i18n/provider";
import { useAuth } from "@/lib/auth";
import { api, sessionKey } from "@/lib/api";
import { defaultRetry } from "@/lib/query-policy";
import { TextButton } from "@/components/ui/text-button";

/** The real persisted paper ledger, separate from the bounded activity
 * feed. Exact decimal strings are shown without conversion through Number. */
export function CopyAccountingHistory({ strategyId }: { strategyId: number }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"ledger" | "fills">("ledger");
  return <details className="orbit-card card-pad" onToggle={(e) => setOpen(e.currentTarget.open)}>
    <summary className="cursor-pointer text-sm font-semibold">{t("copyUpdates.accountingHistory")}</summary>
    {open ? <>
      <div className="my-3 flex gap-3" role="tablist" aria-label={t("copyUpdates.accountingHistory")}>
        {(["ledger", "fills"] as const).map((value) => <button type="button" key={value} role="tab" aria-selected={kind === value} className={`rounded px-3 py-2 text-xs ${kind === value ? "bg-raised text-primary-text" : "text-muted-foreground"}`} onClick={() => setKind(value)}>{t(`copyUpdates.${value}`)}</button>)}
      </div>
      <AccountingPage key={`${strategyId}:${kind}`} strategyId={strategyId} kind={kind} />
    </> : null}
  </details>;
}

function AccountingPage({ strategyId, kind }: { strategyId: number; kind: "ledger" | "fills" }) {
  const { t, format } = useI18n();
  const { status, identity, mode } = useAuth();
  const [pages, setPages] = useState<string[]>([]);
  const before = pages.at(-1);
  const query = useQuery({
    queryKey: ["copy", "accounting", identity, mode, sessionKey(), strategyId, kind, before],
    queryFn: async ({ signal }) => {
      const data = await api.get<unknown>(`/me/copy/strategies/${strategyId}/${kind}?limit=50${before ? `&before=${before}` : ""}`, signal);
      return kind === "ledger" ? { kind: "ledger" as const, ...wireCopyLedgerSchema.parse(data) } : { kind: "fills" as const, ...wireCopyFillsSchema.parse(data) };
    },
    enabled: status === "signedIn",
    ...defaultRetry,
  });
  if (query.isError) return <p role="alert" className="py-3 text-xs text-negative">{t("copyUpdates.historyError")} <TextButton busy={query.isFetching} onClick={() => void query.refetch()}>{t("copyUpdates.retry")}</TextButton></p>;
  if (!query.data) return <p role="status" className="py-3 text-xs text-muted-foreground">{t("common.loading")}</p>;
  const data = query.data;
  return <div role="tabpanel">
    {data.items.length === 0 ? <p className="py-3 text-xs text-muted-foreground">{t("copyUpdates.activityEmpty")}</p> : <ul className="divide-y-2 divide-dotted divide-border">
      {data.kind === "ledger" ? data.items.map((row) => <li key={row.id} className="flex flex-wrap justify-between gap-2 py-3 text-xs">
        <div className="min-w-0"><p>{copyRecordLabel("ledgerKinds", row.kind, t)}{row.coin ? ` · ${row.coin}` : ""}</p><time className="text-muted-foreground" dateTime={row.createdAt}>{format.dateTime(row.createdAt)}</time><p className="text-muted-foreground">#{row.id}{row.orderId ? ` · ${t("trader.tabs.orders")} #${row.orderId}` : ""}</p></div>
        <span className="num break-all" title={row.amount}>{row.amount} USDC</span>
      </li>) : data.items.map((row) => <li key={row.id} className="flex flex-wrap justify-between gap-2 py-3 text-xs">
        <div className="min-w-0"><p>{row.coin} · {t(row.side === "B" ? "portfolio.copy.order.buy" : "portfolio.copy.order.sell")}</p><time className="text-muted-foreground" dateTime={row.ts}>{format.dateTime(row.ts)}</time><p className="text-muted-foreground">#{row.id} · {t("trader.tabs.orders")} #{row.orderId}</p></div>
        <div className="num min-w-0 break-all text-right"><p>{row.size} × {row.px}</p><p>{t("copyUpdates.fee")}: {row.fee} + {row.builderFee} USDC</p><p>PnL: {row.realizedPnl} USDC</p></div>
      </li>)}
    </ul>}
    <div className="mt-3 flex justify-end gap-3 text-xs">
      {pages.length ? <button type="button" disabled={query.isFetching} className="rounded px-3 py-2 text-primary-text" onClick={() => setPages((value) => value.slice(0, -1))}>{t("portfolio.copy.detail.back")}</button> : null}
      {data.hasMore && data.previousCursor ? <button type="button" disabled={query.isFetching} className="rounded px-3 py-2 text-primary-text" onClick={() => setPages((value) => [...value, data.previousCursor!])}>{t("copyUpdates.loadOlder")}</button> : null}
    </div>
  </div>;
}
