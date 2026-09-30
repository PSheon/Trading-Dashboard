"use client";

import { ArrowLeft, ChevronDown, Pause, Pencil, Play, Plus, Square } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { cn } from "cn";

import { PaperBadge } from "@/components/copy/paper-badge";
import { TraderAvatar, boardName } from "@/components/discover/board-bits";
import { CoinIcon } from "@/components/traders/coin-icon";
import { RoiPill } from "@/components/traders/bits";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/dialog";
import { useI18n } from "@/i18n/provider";
import type { MessageKey } from "@/i18n/messages";
import { apiErrorCode } from "@/lib/api";
import type { CopyOrderView, CopyOverview, CopyPositionView, CopyStrategyView } from "@/lib/contracts";
import { copyDays, useAddCopyFunds, useCopyCommand, useCopyOrders, usePatchCopy } from "@/lib/copy";
import { useTraderCards } from "@/lib/favorite-groups";
import { coinLabel, truncateAddress } from "@/lib/format";

type Leader = { address: string; displayName: string | null; avatarUrl: string | null };

/** Names and avatars of the copied leaders (the discovery cards read). */
export function useLeaders(strategies: CopyStrategyView[]): Map<string, Leader> {
  const addresses = useMemo(() => [...new Set(strategies.map((s) => s.leaderAddress))].sort(), [strategies]);
  const cards = useTraderCards(addresses);
  return useMemo(() => {
    const byAddress = new Map<string, Leader>();
    for (const a of addresses) byAddress.set(a, { address: a, displayName: null, avatarUrl: null });
    for (const c of cards.data?.items ?? []) byAddress.set(c.address.toLowerCase(), { address: c.address.toLowerCase(), displayName: c.displayName ?? null, avatarUrl: c.avatarUrl ?? null });
    return byAddress;
  }, [addresses, cards.data]);
}

const tone = (v: number | null | undefined) => (v === null || v === undefined ? "" : v >= 0 ? "text-positive" : "text-negative");

function StatusBadges({ s, className }: { s: CopyStrategyView; className?: string }) {
  const { t } = useI18n();
  const chip = "rounded-full px-2 py-0.5 text-[11px] font-semibold";
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      {s.status !== "active" ? <span className={cn(chip, "bg-raised text-muted-foreground")}>{t(`portfolio.copy.status.${s.status}` as MessageKey)}</span> : null}
      {s.reduceOnly && s.status !== "stopped" ? <span className={cn(chip, "bg-warning/15 text-warning")}>{t("portfolio.copy.status.reduceOnly")}</span> : null}
    </span>
  );
}

/** The paper account beside the wallet's 總價值: virtual USDC only. */
export function PaperAccountCard({ overview, className }: { overview: CopyOverview; className?: string }) {
  const { t, format } = useI18n();
  const p = overview.paper;
  return (
    <section className={cn("rounded-2xl border border-border bg-card p-6", className)} aria-label={t("portfolio.copy.paperAccount")}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-[0.8125rem] text-muted-foreground">{t("portfolio.copy.paperAccount")}</p>
        <PaperBadge />
      </div>
      <p className="num text-[2.5rem] leading-tight font-extrabold tracking-tight">{p.totalValue === null ? "—" : format.usd(p.totalValue, { digits: 2 })}</p>
      <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
        <div>
          <dt className="text-muted-foreground">{t("portfolio.copy.paperBalance")}</dt>
          <dd className="num mt-0.5 font-semibold">{format.usd(p.balance, { digits: 2 })}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("portfolio.copy.allocated")}</dt>
          <dd className="num mt-0.5 font-semibold">{format.usd(p.allocated, { digits: 2 })}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("portfolio.copy.totalPnl")}</dt>
          <dd className={cn("num mt-0.5 font-semibold", tone(p.totalPnl))}>{p.totalPnl === null ? "—" : format.usd(p.totalPnl, { sign: true, digits: 2 })}</dd>
        </div>
      </dl>
      <p className="mt-3 text-[11px] text-subtle-foreground">{t("portfolio.copy.paperHint")}</p>
    </section>
  );
}

function PositionLine({ p, table }: { p: CopyPositionView; table: boolean }) {
  const { t, format } = useI18n();
  const long = p.size > 0;
  const roi = p.unrealizedPnl !== null && p.notionalUsd ? p.unrealizedPnl / (Math.abs(p.size) * p.entryPx) : null;
  const cells = (
    <>
      <span className="flex items-center gap-2">
        <CoinIcon coin={p.coin} size={18} />
        <span className="font-semibold">{coinLabel(p.coin)}</span>
        <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-semibold", long ? "bg-positive-soft text-positive" : "bg-negative-soft text-negative")}>
          {t(long ? "portfolio.copy.long" : "portfolio.copy.short")}
        </span>
      </span>
      <span className="num text-muted-foreground">{format.num(Math.abs(p.size), 4)}</span>
      <span className="num">{p.notionalUsd === null ? "—" : format.usd(p.notionalUsd, { digits: 2 })}</span>
      <span className={cn("num font-semibold", tone(p.unrealizedPnl))}>{p.unrealizedPnl === null ? "—" : format.usd(p.unrealizedPnl, { sign: true, digits: 2 })}</span>
      <span>{roi === null ? "—" : <RoiPill value={roi} />}</span>
    </>
  );
  return table ? (
    <div className="grid grid-cols-[1.6fr_1fr_1fr_1fr_0.8fr] items-center gap-3 px-4 py-2 text-[0.8125rem]">{cells}</div>
  ) : (
    <div className="grid grid-cols-[1.4fr_1fr_1fr] items-center gap-2 py-2 text-xs [&>*:nth-child(2)]:hidden [&>*:nth-child(5)]:hidden">{cells}</div>
  );
}

/** CopyDog's desktop list of copies: trader, days, positions, equity, curve, UPNL, P&L, ROI and the positions toggle. */
export function CopyTable({ strategies, leaders, onSelect }: { strategies: CopyStrategyView[]; leaders: Map<string, Leader>; onSelect: (id: number) => void }) {
  const { t, format } = useI18n();
  const [open, setOpen] = useState<Set<number>>(new Set());
  const cols = "grid grid-cols-[2.2fr_0.8fr_0.8fr_1.1fr_1fr_1.1fr_1.1fr_0.9fr_40px] items-center gap-3";
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card">
      <div className={cn(cols, "border-b border-border px-4 py-3 text-xs text-muted-foreground")}>
        <span>{t("portfolio.copy.cols.trader")}</span>
        <span className="text-right">{t("portfolio.copy.cols.days")}</span>
        <span className="text-right">{t("portfolio.copy.cols.positions")}</span>
        <span className="text-right">{t("portfolio.copy.cols.equity")}</span>
        <span className="text-right">{t("portfolio.copy.cols.equityCurve")}</span>
        <span className="text-right">{t("portfolio.copy.cols.upnl")}</span>
        <span className="text-right">{t("portfolio.copy.cols.pnl")}</span>
        <span className="text-right">{t("portfolio.copy.cols.roi")}</span>
        <span aria-hidden />
      </div>
      {strategies.map((s) => {
        const leader = leaders.get(s.leaderAddress) ?? { address: s.leaderAddress, displayName: null, avatarUrl: null };
        const expanded = open.has(s.id);
        return (
          <div key={s.id} className="border-b border-border last:border-b-0">
            <div
              role="button"
              tabIndex={0}
              onClick={() => onSelect(s.id)}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onSelect(s.id))}
              className={cn(cols, "cursor-pointer px-4 py-3 text-[0.875rem] outline-none hover:bg-raised/40 focus-visible:bg-raised/40")}
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <TraderAvatar trader={leader} size={30} />
                <span className="truncate font-semibold">{boardName(leader)}</span>
                <PaperBadge />
                <StatusBadges s={s} />
              </span>
              <span className="num text-right">{t("portfolio.copy.daysShort", { count: copyDays(s.createdAt) })}</span>
              <span className="num text-right">{s.positions.length}</span>
              <span className="num text-right">{s.equity === null ? "—" : format.usd(s.equity, { digits: 2 })}</span>
              <span className="text-right text-muted-foreground">—</span>
              <span className={cn("num text-right", s.positions.length ? tone(s.unrealizedPnl) : "")}>
                {s.positions.length && s.unrealizedPnl !== null ? format.usd(s.unrealizedPnl, { sign: true, digits: 2 }) : "—"}
              </span>
              <span className={cn("num text-right font-semibold", tone(s.totalPnl))}>{s.totalPnl === null ? "—" : format.usd(s.totalPnl, { sign: true, digits: 2 })}</span>
              <span className="text-right">{s.roiPct === null ? "—" : <RoiPill value={s.roiPct / 100} />}</span>
              <span className="flex justify-end">
                {s.positions.length ? (
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-label={t(expanded ? "portfolio.copy.hidePositions" : "portfolio.copy.showPositions")}
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpen((cur) => {
                        const next = new Set(cur);
                        if (next.has(s.id)) next.delete(s.id);
                        else next.add(s.id);
                        return next;
                      });
                    }}
                    className="inline-flex size-8 items-center justify-center rounded-full bg-raised outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <ChevronDown className={cn("size-4 transition-transform", expanded && "rotate-180")} />
                  </button>
                ) : null}
              </span>
            </div>
            {expanded ? <div className="border-t border-border bg-raised/25">{s.positions.map((p) => <PositionLine key={p.coin} p={p} table />)}</div> : null}
          </div>
        );
      })}
    </div>
  );
}

/** CopyDog's phone copy card: avatar, name + badges, equity, P&L + ROI, and the UPNL row with coins. */
export function CopyCards({ strategies, leaders, onSelect }: { strategies: CopyStrategyView[]; leaders: Map<string, Leader>; onSelect: (id: number) => void }) {
  const { t, format } = useI18n();
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="flex flex-col gap-3">
      {strategies.map((s) => {
        const leader = leaders.get(s.leaderAddress) ?? { address: s.leaderAddress, displayName: null, avatarUrl: null };
        return (
          <div key={s.id} className="rounded-2xl border border-border bg-card">
            <button type="button" onClick={() => onSelect(s.id)} className="flex w-full items-center gap-3 p-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <TraderAvatar trader={leader} size={44} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-[0.9375rem] font-bold">{boardName(leader)}</span>
                  <PaperBadge />
                  <StatusBadges s={s} />
                </span>
                <span className="num text-xs text-muted-foreground">{s.equity === null ? "—" : format.usd(s.equity, { digits: 2 })}</span>
              </span>
              <span className="flex flex-col items-end gap-1">
                <span className={cn("num text-[0.9375rem] font-bold", tone(s.totalPnl))}>{s.totalPnl === null ? "—" : format.usd(s.totalPnl, { sign: true, digits: 2 })}</span>
                {s.roiPct === null ? null : <RoiPill value={s.roiPct / 100} />}
              </span>
            </button>
            <div className="flex items-center gap-2 border-t border-border px-4 py-2.5 text-xs">
              {s.positions.length ? (
                <>
                  <span className="text-muted-foreground">{t("portfolio.copy.cols.upnl")}</span>
                  <span className={cn("num font-semibold", tone(s.unrealizedPnl))}>{s.unrealizedPnl === null ? "—" : format.usd(s.unrealizedPnl, { sign: true, digits: 2 })}</span>
                  <span className="ml-auto flex -space-x-1">{s.positions.slice(0, 4).map((p) => <CoinIcon key={p.coin} coin={p.coin} size={18} />)}</span>
                  <button
                    type="button"
                    aria-expanded={open === s.id}
                    aria-label={t(open === s.id ? "portfolio.copy.hidePositions" : "portfolio.copy.showPositions")}
                    onClick={() => setOpen((o) => (o === s.id ? null : s.id))}
                    className="inline-flex size-7 items-center justify-center rounded-full bg-raised outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <ChevronDown className={cn("size-4 transition-transform", open === s.id && "rotate-180")} />
                  </button>
                </>
              ) : (
                <span className="text-muted-foreground">{t("portfolio.copy.noOpenPositions")}</span>
              )}
            </div>
            {open === s.id ? <div className="border-t border-border px-4">{s.positions.map((p) => <PositionLine key={p.coin} p={p} table={false} />)}</div> : null}
          </div>
        );
      })}
    </div>
  );
}

function orderReason(o: CopyOrderView): string | null {
  if (!o.reason || o.status === "filled") return null;
  return o.reason.replaceAll("_", " ");
}

/** One copy: CopyDog's account view (your copy, P&L, ROI, capital, equity, days, direction), its actions, settings, positions and paper orders. */
export function CopyDetail({ strategy: s, leader, balance, onBack }: { strategy: CopyStrategyView; leader: Leader; balance: number; onBack: () => void }) {
  const { t, format } = useI18n();
  const command = useCopyCommand();
  const orders = useCopyOrders(s.id);
  const [dialog, setDialog] = useState<"stop" | "edit" | "funds" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = s.status !== "stopped";
  const run = async (c: "pause" | "resume") => {
    setError(null);
    try {
      await command.mutateAsync({ id: s.id, command: c });
    } catch {
      setError(t("portfolio.copy.edit.failed"));
    }
  };
  const stat = (label: string, value: React.ReactNode, cls = "") => (
    <div className="rounded-xl bg-raised/50 p-3">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={cn("num mt-1 text-[0.9375rem] font-bold", cls)}>{value}</p>
    </div>
  );
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={onBack} aria-label={t("portfolio.copy.detail.back")} className="inline-flex size-9 items-center justify-center rounded-full bg-raised outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <ArrowLeft className="size-4" />
        </button>
        <TraderAvatar trader={leader} size={40} />
        <div className="min-w-0">
          <Link href={`/trader/${s.leaderAddress}`} className="flex items-center gap-2 text-base font-bold hover:underline">
            {boardName(leader)}
          </Link>
          <p className="num text-xs text-muted-foreground">{truncateAddress(s.leaderAddress)}</p>
        </div>
        <PaperBadge />
        <StatusBadges s={s} />
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
        {stat(t("portfolio.copy.detail.totalPnl"), s.totalPnl === null ? "—" : format.usd(s.totalPnl, { sign: true, digits: 2 }), tone(s.totalPnl))}
        {stat(t("portfolio.copy.detail.roi"), s.roiPct === null ? "—" : format.pct(s.roiPct / 100, { sign: true, digits: 2 }), tone(s.roiPct))}
        {stat(t("portfolio.copy.detail.initialCapital"), format.usd(s.allocated, { digits: 2 }))}
        {stat(t("portfolio.copy.detail.equity"), s.equity === null ? "—" : format.usd(s.equity, { digits: 2 }))}
        {stat(t("portfolio.copy.detail.copying"), t("portfolio.copy.daysShort", { count: copyDays(s.createdAt) }))}
        {stat(t("portfolio.copy.detail.direction"), t(s.settings.direction === "same" ? "portfolio.copy.detail.same" : "portfolio.copy.detail.counter"))}
      </div>

      {live ? (
        <div className="flex flex-wrap gap-2">
          {s.status === "paused" ? (
            <Button variant="secondary" onClick={() => run("resume")} disabled={command.isPending}>
              <Play /> {t("portfolio.copy.actions.resume")}
            </Button>
          ) : s.status === "active" ? (
            <Button variant="secondary" onClick={() => run("pause")} disabled={command.isPending}>
              <Pause /> {t("portfolio.copy.actions.pause")}
            </Button>
          ) : null}
          <Button variant="secondary" onClick={() => setDialog("edit")} disabled={s.status === "stopping"}>
            <Pencil /> {t("portfolio.copy.actions.edit")}
          </Button>
          <Button variant="secondary" onClick={() => setDialog("funds")} disabled={s.status === "stopping"}>
            <Plus /> {t("portfolio.copy.actions.addFunds")}
          </Button>
          <Button variant="secondary" className="text-negative" onClick={() => setDialog("stop")} disabled={s.status === "stopping"}>
            <Square /> {t("portfolio.copy.actions.stop")}
          </Button>
        </div>
      ) : null}
      {error ? <p role="alert" className="text-xs font-semibold text-negative">{error}</p> : null}

      <div className="grid gap-4 md:grid-cols-[1fr_1.4fr]">
        <section className="rounded-2xl border border-border bg-card p-4">
          <h3 className="flex items-center justify-between text-sm font-bold">
            {t("portfolio.copy.detail.copySettings")}
            <span className="text-[11px] font-normal text-muted-foreground">{t("portfolio.copy.detail.version", { version: s.version })}</span>
          </h3>
          <dl className="mt-3 grid gap-2 text-[0.8125rem]">
            {[
              [t("portfolio.copy.detail.mode"), t(s.settings.sizingMode === "ratio" ? "portfolio.copy.detail.ratio" : "portfolio.copy.detail.fixed")],
              [t("portfolio.copy.detail.perTrade"), s.settings.sizingMode === "fixed" && s.settings.perTradeUsd ? format.usd(s.settings.perTradeUsd, { digits: 2 }) : "—"],
              [t("portfolio.copy.detail.maxAllocation"), format.usd(s.settings.maxTotalExposureUsd ?? s.allocated * 5, { digits: 2 })],
              [t("portfolio.copy.detail.copyExisting"), t(s.settings.copyStartMode === "adopt" ? "portfolio.copy.detail.on" : "portfolio.copy.detail.off")],
              [t("portfolio.copy.detail.realized"), format.usd(s.realizedPnl, { sign: true, digits: 2 })],
              [t("portfolio.copy.detail.fees"), format.usd(-s.fees, { digits: 2 })],
              [t("portfolio.copy.detail.funding"), format.usd(-s.funding, { digits: 2 })],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="num font-semibold">{v}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section className="rounded-2xl border border-border bg-card">
          <h3 className="border-b border-border px-4 py-3 text-sm font-bold">{t("portfolio.copy.detail.positions")}</h3>
          {s.positions.length ? s.positions.map((p) => <PositionLine key={p.coin} p={p} table />) : <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t("portfolio.copy.noOpenPositions")}</p>}
        </section>
      </div>

      <section className="rounded-2xl border border-border bg-card">
        <h3 className="border-b border-border px-4 py-3 text-sm font-bold">{t("portfolio.copy.detail.orders")}</h3>
        {orders.data && orders.data.items.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <p className="text-sm font-bold">{t("portfolio.copy.detail.noOrders")}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t("portfolio.copy.detail.noOrdersDesc")}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-[0.8125rem]">
              <thead className="text-xs text-muted-foreground">
                <tr className="[&>th]:px-4 [&>th]:py-2 [&>th]:text-left [&>th]:font-normal">
                  <th>{t("portfolio.copy.order.time")}</th>
                  <th>{t("portfolio.copy.order.coin")}</th>
                  <th>{t("portfolio.copy.order.side")}</th>
                  <th className="text-right!">{t("portfolio.copy.order.size")}</th>
                  <th className="text-right!">{t("portfolio.copy.order.price")}</th>
                  <th>{t("portfolio.copy.order.status")}</th>
                </tr>
              </thead>
              <tbody>
                {(orders.data?.items ?? []).map((o) => (
                  <tr key={o.id} className="border-t border-border [&>td]:px-4 [&>td]:py-2">
                    <td className="num whitespace-nowrap text-muted-foreground">{format.dateTime(o.createdAt)}</td>
                    <td className="font-semibold">{coinLabel(o.coin)}</td>
                    <td>
                      <span className={o.side === "B" ? "text-positive" : "text-negative"}>{t(o.side === "B" ? "portfolio.copy.order.buy" : "portfolio.copy.order.sell")}</span>
                      <span className="ml-1.5 text-xs text-muted-foreground">{t(`portfolio.copy.order.leg.${o.leg}` as MessageKey)}</span>
                    </td>
                    <td className="num text-right">{format.num(o.filledSize || o.size, 5)}</td>
                    <td className="num text-right">{o.avgPx === null ? "—" : format.price(o.avgPx)}</td>
                    <td>
                      <span className={cn("font-semibold", o.status === "filled" || o.status === "partial" ? "text-positive" : o.status === "rejected" || o.status === "cancelled" ? "text-negative" : "text-muted-foreground")}>
                        {t(`portfolio.copy.order.statusName.${o.status}` as MessageKey)}
                      </span>
                      {orderReason(o) ? <span className="ml-1.5 text-xs text-muted-foreground">{orderReason(o)}</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <StopDialog strategy={s} open={dialog === "stop"} onClose={() => setDialog(null)} />
      <EditDialog strategy={s} balance={balance} open={dialog === "edit"} onClose={() => setDialog(null)} />
      <FundsDialog strategy={s} balance={balance} open={dialog === "funds"} onClose={() => setDialog(null)} />
    </div>
  );
}

/** CopyDog's 停止跟單: with open positions it's 停止並平倉 (they are closed). */
function StopDialog({ strategy: s, open, onClose }: { strategy: CopyStrategyView; open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const command = useCopyCommand();
  const [error, setError] = useState<string | null>(null);
  const n = s.positions.length;
  return (
    <Modal open={open} onOpenChange={(o) => !o && onClose()} title={t("portfolio.copy.stop.title")} badge={<PaperBadge />}>
      <div className="flex flex-col gap-5 p-5">
        <p className="text-sm text-muted-foreground">{n ? t("portfolio.copy.stop.withPositions", { count: n }) : t("portfolio.copy.stop.noPositions")}</p>
        {error ? <p role="alert" className="text-xs font-semibold text-negative">{error}</p> : null}
        <div className="grid grid-cols-2 gap-3">
          <Button variant="secondary" size="lg" onClick={onClose}>{t("portfolio.copy.stop.cancel")}</Button>
          <Button
            size="lg"
            className="bg-negative text-white hover:bg-negative/90"
            disabled={command.isPending}
            onClick={async () => {
              setError(null);
              try {
                await command.mutateAsync({ id: s.id, command: "stop" });
                onClose();
              } catch {
                setError(t("portfolio.copy.stop.failed"));
              }
            }}
          >
            {command.isPending ? t("portfolio.copy.stop.stopping") : n ? t("portfolio.copy.stop.stopAndClose") : t("portfolio.copy.stop.stop")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function AmountInput({ id, value, onChange, invalid }: { id: string; value: string; onChange: (v: string) => void; invalid?: boolean }) {
  return (
    <div className={cn("flex h-12 items-center gap-1 rounded-xl border bg-raised px-4", invalid ? "border-negative" : "border-border-strong")}>
      <span className="text-lg font-semibold text-muted-foreground">$</span>
      <input id={id} inputMode="decimal" placeholder="0" value={value} onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, "").slice(0, 12))} className="num w-full bg-transparent text-lg font-semibold outline-none" />
    </div>
  );
}

/** CopyDog's 跟單交易設定: max allocation, and the amount per trade unless ratio. Saves a new version. */
function EditDialog({ strategy: s, balance, open, onClose }: { strategy: CopyStrategyView; balance: number; open: boolean; onClose: () => void }) {
  const { t, format } = useI18n();
  const patch = usePatchCopy();
  const [mode, setMode] = useState(s.settings.sizingMode);
  const [maxAlloc, setMaxAlloc] = useState(String(Math.floor(s.settings.maxTotalExposureUsd ?? s.allocated * 5)));
  const [perTrade, setPerTrade] = useState(s.settings.perTradeUsd ? String(Math.floor(s.settings.perTradeUsd)) : "");
  const [error, setError] = useState<string | null>(null);
  const max = Number.parseFloat(maxAlloc);
  const per = Number.parseFloat(perTrade);
  const invalid = !(max > 0) || (mode === "fixed" && (!(per > 0) || per > max));
  return (
    <Modal open={open} onOpenChange={(o) => !o && onClose()} title={t("portfolio.copy.edit.title")} badge={<PaperBadge />}>
      <div className="flex flex-col gap-5 p-5">
        <div role="radiogroup" className="grid grid-cols-2 gap-1 rounded-full bg-raised p-1">
          {(["fixed", "ratio"] as const).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)} className={cn("h-9 rounded-full text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring", mode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground")}>
              {t(m === "fixed" ? "portfolio.copy.edit.fixed" : "portfolio.copy.edit.ratio")}
            </button>
          ))}
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor="edit-max" className="flex justify-between text-sm font-semibold">
            {t("portfolio.copy.edit.maxAllocation")}
            <span className="text-xs font-medium text-muted-foreground">{t("portfolio.copy.funds.available", { balance: format.num(balance, 2) })}</span>
          </label>
          <AmountInput id="edit-max" value={maxAlloc} onChange={setMaxAlloc} invalid={!(max > 0)} />
        </div>
        {mode === "fixed" ? (
          <div className="flex flex-col gap-2">
            <label htmlFor="edit-per" className="flex justify-between text-sm font-semibold">
              {t("portfolio.copy.edit.amountPerTrade")}
              {max > 0 ? <span className="text-xs font-medium text-muted-foreground">{t("portfolio.copy.edit.maxLabel", { max: format.num(Math.floor(max)) })}</span> : null}
            </label>
            <AmountInput id="edit-per" value={perTrade} onChange={setPerTrade} invalid={perTrade !== "" && (!(per > 0) || per > max)} />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{t("portfolio.copy.edit.ratioExplanation")}</p>
        )}
        {error ? <p role="alert" className="text-xs font-semibold text-negative">{error}</p> : null}
        <Button
          size="xl"
          disabled={invalid || patch.isPending}
          onClick={async () => {
            setError(null);
            try {
              await patch.mutateAsync({ id: s.id, patch: { sizingMode: mode, maxTotalExposureUsd: max, perTradeUsd: mode === "fixed" ? per : s.settings.perTradeUsd } });
              onClose();
            } catch {
              setError(t("portfolio.copy.edit.failed"));
            }
          }}
        >
          {patch.isPending ? t("portfolio.copy.edit.saving") : t("portfolio.copy.edit.save")}
        </Button>
      </div>
    </Modal>
  );
}

/** CopyDog's 加碼: more paper USDC from the paper balance. */
function FundsDialog({ strategy: s, balance, open, onClose }: { strategy: CopyStrategyView; balance: number; open: boolean; onClose: () => void }) {
  const { t, format } = useI18n();
  const add = useAddCopyFunds();
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const value = Number.parseFloat(amount);
  const invalid = !(value > 0) || value > balance;
  return (
    <Modal open={open} onOpenChange={(o) => !o && onClose()} title={t("portfolio.copy.funds.title")} badge={<PaperBadge />}>
      <div className="flex flex-col gap-4 p-5">
        <label htmlFor="funds-amount" className="flex justify-between text-sm font-semibold">
          USDC
          <span className="text-xs font-medium text-muted-foreground">{t("portfolio.copy.funds.available", { balance: format.num(balance, 2) })}</span>
        </label>
        <AmountInput id="funds-amount" value={amount} onChange={setAmount} invalid={amount !== "" && invalid} />
        <div className="grid grid-cols-4 gap-2">
          {[10, 25, 50, 100].map((p) => (
            <button key={p} type="button" onClick={() => setAmount(String(Math.floor((balance * p) / 100)))} className="h-9 rounded-full bg-raised text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {p === 100 ? t("trader.copy.max") : `${p}%`}
            </button>
          ))}
        </div>
        {error ? <p role="alert" className="text-xs font-semibold text-negative">{error}</p> : null}
        <Button
          size="xl"
          disabled={invalid || add.isPending}
          onClick={async () => {
            setError(null);
            try {
              await add.mutateAsync({ id: s.id, amountUsd: value });
              setAmount("");
              onClose();
            } catch (err) {
              setError(apiErrorCode(err) === "insufficient_balance" ? t("trader.copy.errors.exceedsBalance") : t("portfolio.copy.funds.failed"));
            }
          }}
        >
          {t("portfolio.copy.funds.confirm")}
        </Button>
      </div>
    </Modal>
  );
}

/** Phone Insights: paper P&L split and each trader's contribution. */
export function CopyInsights({ overview, leaders }: { overview: CopyOverview; leaders: Map<string, Leader> }) {
  const { t, format } = useI18n();
  const all = overview.strategies;
  const realized = all.reduce((a, s) => a + s.realizedPnl, 0);
  const unrealized = all.reduce<number | null>((a, s) => (a === null || s.unrealizedPnl === null ? null : a + s.unrealizedPnl), 0);
  const costs = all.reduce((a, s) => a + s.fees + s.funding, 0);
  const trades = all.reduce((a, s) => a + s.tradesCopied, 0);
  const maxAbs = Math.max(1, ...all.map((s) => Math.abs(s.totalPnl ?? 0)));
  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-2xl border border-border bg-card p-4">
        <h3 className="flex items-center justify-between text-sm font-bold">{t("portfolio.copy.insights.overview")} <PaperBadge /></h3>
        <p className={cn("num mt-2 text-2xl font-extrabold", tone(overview.paper.totalPnl))}>{overview.paper.totalPnl === null ? "—" : format.usd(overview.paper.totalPnl, { sign: true, digits: 2 })}</p>
        <dl className="mt-3 grid grid-cols-2 gap-3 text-xs">
          {[
            [t("portfolio.copy.insights.realized"), format.usd(realized, { sign: true, digits: 2 }), tone(realized)],
            [t("portfolio.copy.insights.unrealized"), unrealized === null ? "—" : format.usd(unrealized, { sign: true, digits: 2 }), tone(unrealized)],
            [t("portfolio.copy.insights.fees"), format.usd(-costs, { digits: 2 }), ""],
            [t("portfolio.copy.insights.tradesCopied"), format.num(trades), ""],
          ].map(([k, v, c]) => (
            <div key={k} className="rounded-xl bg-raised/50 p-3">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className={cn("num mt-1 text-sm font-bold", c)}>{v}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="rounded-2xl border border-border bg-card p-4">
        <h3 className="text-sm font-bold">{t("portfolio.copy.insights.byTrader")}</h3>
        <ul className="mt-3 flex flex-col gap-3">
          {all.map((s) => {
            const leader = leaders.get(s.leaderAddress) ?? { address: s.leaderAddress, displayName: null, avatarUrl: null };
            const v = s.totalPnl ?? 0;
            return (
              <li key={s.id} className="flex items-center gap-2.5 text-xs">
                <TraderAvatar trader={leader} size={24} />
                <span className="w-24 truncate font-semibold">{boardName(leader)}</span>
                <span className="relative h-2 flex-1 rounded-full bg-raised">
                  <span className={cn("absolute inset-y-0 left-0 rounded-full", v >= 0 ? "bg-positive" : "bg-negative")} style={{ width: `${(Math.abs(v) / maxAbs) * 100}%` }} />
                </span>
                <span className={cn("num w-20 text-right font-semibold", tone(s.totalPnl))}>{s.totalPnl === null ? "—" : format.usd(s.totalPnl, { sign: true, digits: 2 })}</span>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

/** Phone Exposure: long / short split, weighted leverage and each coin across every live copy. */
export function CopyExposure({ overview }: { overview: CopyOverview }) {
  const { t, format } = useI18n();
  const live = overview.strategies.filter((s) => s.status !== "stopped");
  const byCoin = new Map<string, { long: number; short: number }>();
  for (const s of live) for (const p of s.positions) {
    const cur = byCoin.get(p.coin) ?? { long: 0, short: 0 };
    if (p.size > 0) cur.long += p.notionalUsd ?? 0;
    else cur.short += p.notionalUsd ?? 0;
    byCoin.set(p.coin, cur);
  }
  const long = [...byCoin.values()].reduce((a, c) => a + c.long, 0);
  const short = [...byCoin.values()].reduce((a, c) => a + c.short, 0);
  const equity = live.reduce((a, s) => a + (s.equity ?? 0), 0);
  const leverage = equity > 0 ? (long + short) / equity : 0;
  const total = long + short;
  if (total === 0) return <p className="py-8 text-center text-sm text-muted-foreground">{t("portfolio.copy.exposure.none")}</p>;
  const rows = [...byCoin.entries()].sort((a, b) => b[1].long + b[1].short - (a[1].long + a[1].short));
  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-2xl border border-border bg-card p-4">
        <h3 className="flex items-center justify-between text-sm font-bold">{t("portfolio.copy.exposure.direction")} <PaperBadge /></h3>
        <div className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-raised">
          <span className="bg-positive" style={{ width: `${(long / total) * 100}%` }} />
          <span className="bg-negative" style={{ width: `${(short / total) * 100}%` }} />
        </div>
        <div className="mt-2 flex justify-between text-xs">
          <span className="text-positive">{t("portfolio.copy.exposure.long")} {format.usd(long, { compact: true })}</span>
          <span className="text-negative">{t("portfolio.copy.exposure.short")} {format.usd(short, { compact: true })}</span>
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-3 text-xs">
          <div className="rounded-xl bg-raised/50 p-3">
            <dt className="text-muted-foreground">{t("portfolio.copy.exposure.leverage")} · {t("portfolio.copy.exposure.weightedAvg")}</dt>
            <dd className="num mt-1 text-sm font-bold">{leverage.toFixed(2)}×</dd>
          </div>
          <div className="rounded-xl bg-raised/50 p-3">
            <dt className="text-muted-foreground">{t("portfolio.copy.exposure.equity")}</dt>
            <dd className="num mt-1 text-sm font-bold">{format.usd(equity, { digits: 2 })}</dd>
          </div>
        </dl>
      </section>
      <section className="rounded-2xl border border-border bg-card p-4">
        <h3 className="text-sm font-bold">{t("portfolio.copy.exposure.byAsset")}</h3>
        <ul className="mt-2">
          {rows.map(([coin, v]) => (
            <li key={coin} className="flex items-center gap-2.5 border-b border-border py-2.5 text-xs last:border-b-0">
              <CoinIcon coin={coin} size={20} />
              <span className="w-16 font-semibold">{coinLabel(coin)}</span>
              <span className="relative h-2 flex-1 rounded-full bg-raised">
                <span className={cn("absolute inset-y-0 left-0 rounded-full", v.long >= v.short ? "bg-positive" : "bg-negative")} style={{ width: `${((v.long + v.short) / total) * 100}%` }} />
              </span>
              <span className="num w-20 text-right font-semibold">{format.usd(v.long + v.short, { compact: true })}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
