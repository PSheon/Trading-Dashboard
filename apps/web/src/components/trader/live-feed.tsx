"use client";

import type { TraderFill, TraderTransfer } from "@/lib/contracts";
import { useMemo } from "react";
import { cn } from "cn";

import { Skeleton } from "@/components/page";
import { CoinIcon } from "@/components/traders/coin-icon";
import { useI18n } from "@/i18n/provider";
import { coinLabel } from "@/lib/format";
import { mergeLiveFills } from "@/lib/live-trader";
import { useTraderFills, useTraderTransfers } from "@/lib/queries";
import { feedTime, price, qty, signedUsd2, usd2 } from "@/lib/trade-format";
import { groupFills, type FillGroup } from "./trader-tabs";

const NO_FILLS: TraderFill[] = [];
/** CopyDog lists at most this many events. */
const MAX_EVENTS = 200;

type EvtKey = "openLong" | "closeLong" | "openShort" | "closeShort" | "flipLong" | "flipShort" | "liquidated" | "buy" | "sell";

function eventKey(g: FillGroup): EvtKey | null {
  if (g.liquidation) return "liquidated";
  switch (g.dir) {
    case "Open Long": return "openLong";
    case "Close Long": return "closeLong";
    case "Open Short": return "openShort";
    case "Close Short": return "closeShort";
    case "Long > Short": return "flipShort";
    case "Short > Long": return "flipLong";
    case "Buy": return "buy";
    case "Sell": return "sell";
    default: return null;
  }
}

type FeedEvent = ({ source: "fill" } & FillGroup) | ({ source: "xfer"; key: string; at: number } & TraderTransfer);

function FillRow({ ev }: { ev: FillGroup }) {
  const { t } = useI18n();
  const coin = coinLabel(ev.coin);
  const value = `${ev.partial ? "≥" : ""}${usd2(ev.value)}`;
  const key = eventKey(ev);
  const headline = key ? t(`trader.activity.evt.${key}`, { value, coin }) : t("trader.activity.evt.other", { value, coin, dir: ev.dir });
  return (
    <li className="flex gap-3 border-b border-border py-3 last:border-0" title={ev.partial ? t("trader.activity.partial") : undefined}>
      <CoinIcon coin={ev.coin} size={22} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className={cn("truncate text-[13px] font-semibold", ev.liquidation && "text-negative")}>{headline}</span>
          <span className="num shrink-0 font-mono text-[10px] text-subtle-foreground uppercase">{feedTime(ev.time)}</span>
        </div>
        <div className="num font-mono text-[11px] text-muted-foreground">
          {ev.partial ? "≥" : ""}
          {qty(ev.size)} {coin} @ {price(ev.price)}
          {Math.abs(ev.pnl) >= 0.005 ? (
            <span className={ev.pnl >= 0 ? "text-positive" : "text-negative"}> · {signedUsd2(ev.pnl)}</span>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function TransferRow({ ev }: { ev: TraderTransfer }) {
  const { t } = useI18n();
  return (
    <li className="flex gap-3 border-b border-border py-3 last:border-0">
      <CoinIcon coin={ev.token} size={22} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[13px] font-semibold">{t(`trader.activity.xfer.${ev.kind}`, { asset: ev.token })}</span>
          <span className="num shrink-0 font-mono text-[10px] text-subtle-foreground uppercase">{feedTime(ev.time)}</span>
        </div>
        {ev.amount > 0 ? (
          <div className="num font-mono text-[11px] text-muted-foreground">{ev.usd ? usd2(ev.amount) : `${qty(ev.amount)} ${ev.token}`}</div>
        ) : null}
      </div>
    </li>
  );
}

/**
 * CopyDog's 即時動態 (the pulse at the right of the tab bar): the trader's
 * recent fills, grouped by order stream, and transfers since the oldest of
 * them, newest first, kept live by the page's Hyperliquid socket. It takes
 * the copy panel's place; the copy CTA collapses to a button above it.
 */
export function LiveFeed({
  address,
  liveFills = NO_FILLS,
  onCopy,
}: {
  address: string;
  liveFills?: TraderFill[];
  /** The collapsed 跟單 button: back to the copy panel. */
  onCopy: () => void;
}) {
  const { t } = useI18n();
  const fills = useTraderFills(address, 2000);
  const transfers = useTraderTransfers(address);
  const rows = useMemo(() => mergeLiveFills(fills.data, liveFills), [fills.data, liveFills]);
  const events = useMemo<FeedEvent[]>(() => {
    const groups = groupFills(rows ?? []).map((g) => ({ ...g, source: "fill" as const }));
    const oldest = groups.length ? Math.min(...groups.map((g) => g.time)) : 0;
    const xfers = (transfers.data?.transfers ?? [])
      .map((x, i) => ({ ...x, source: "xfer" as const, key: `x${x.time}-${i}`, at: new Date(x.time).getTime() }))
      .filter((x) => x.at >= oldest);
    return [...groups, ...xfers]
      .sort((a, b) => (b.source === "fill" ? b.time : b.at) - (a.source === "fill" ? a.time : a.at))
      .slice(0, MAX_EVENTS);
  }, [rows, transfers.data]);

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-2xl border border-border bg-card p-4">
        <button
          type="button"
          onClick={onCopy}
          className="h-12 w-full rounded-full bg-primary text-base font-bold text-primary-foreground outline-none hover:brightness-105 focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t("trader.copyTrade")}
        </button>
      </div>
      <section className="rounded-2xl border border-border bg-card px-4 pt-3 pb-1" aria-label={t("trader.activity.title")}>
        <div className="flex items-center justify-between pb-1">
          <h2 className="text-sm font-semibold">{t("trader.activity.title")}</h2>
          <span className="flex items-center gap-1.5 text-xs font-semibold text-positive">
            <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-positive" />
            {t("trader.activity.live")}
          </span>
        </div>
        {events.length === 0 ? (
          !rows ? (
            <div className="flex flex-col gap-2 py-3">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          ) : (
            <p className="py-8 text-center text-xs text-muted-foreground">{t("trader.activity.empty")}</p>
          )
        ) : (
          <ul className="max-h-[calc(100dvh-15rem)] overflow-y-auto">
            {events.map((ev) => (ev.source === "fill" ? <FillRow key={ev.key} ev={ev} /> : <TransferRow key={ev.key} ev={ev} />))}
          </ul>
        )}
      </section>
    </div>
  );
}
