"use client";

import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, ReceiptText } from "lucide-react";
import { cn } from "cn";

import { EmptyState, ErrorState, Skeleton } from "@/components/page";
import { useI18n } from "@/i18n/provider";
import type { MessageKey } from "@/i18n/messages";
import type { TraderTransfer } from "@/lib/contracts";
import { useWalletHistory } from "@/lib/wallet";

type Kind = "deposit" | "withdraw" | "send" | "receive" | "internal" | "other";

function kindOf(t: TraderTransfer): Kind {
  switch (t.kind) {
    case "deposit":
      return "deposit";
    case "withdraw":
      return "withdraw";
    case "sent":
      return "send";
    case "received":
      return "receive";
    default:
      return t.direction === "move" ? "internal" : "other";
  }
}

const ICON = { deposit: ArrowDownLeft, receive: ArrowDownLeft, withdraw: ArrowUpRight, send: ArrowUpRight, internal: ArrowLeftRight, other: ArrowLeftRight };

/**
 * The main account's deposits, withdrawals and transfers (GET
 * /me/wallet/history): the 儲值與提款 panel and the phone 交易紀錄 view.
 */
export function WalletHistoryList({ className }: { className?: string }) {
  const { t, format } = useI18n();
  const history = useWalletHistory();

  if (history.isError && !history.data) {
    return <ErrorState message={history.error.message} onRetry={() => history.refetch()} />;
  }
  if (!history.data) {
    return (
      <div className={cn("flex flex-col gap-2", className)}>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    );
  }
  if (history.data.transfers.length === 0) {
    return <EmptyState icon={ReceiptText} title={t("wallet.historyEmpty")} body={t("wallet.historyEmptyBody")} className={className} />;
  }

  return (
    <ul className={cn("divide-y divide-border", className)}>
      {history.data.transfers.map((row) => {
        const kind = kindOf(row);
        const Icon = ICON[kind];
        const sign = row.direction === "in" ? "+" : row.direction === "out" ? "−" : "";
        return (
          <li key={`${row.hash}-${row.kind}-${row.time}`} className="flex items-center gap-3 py-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-raised text-muted-foreground">
              <Icon className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">{t(`wallet.historyKinds.${kind}` as MessageKey)}</p>
              <p className="text-xs text-muted-foreground">{format.dateTime(row.time)}</p>
            </div>
            <span
              className={cn(
                "num text-sm font-semibold",
                row.direction === "in" ? "text-positive" : row.direction === "out" ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {sign}
              {format.num(row.amount, 2)} {row.usd ? "USD" : row.token}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
