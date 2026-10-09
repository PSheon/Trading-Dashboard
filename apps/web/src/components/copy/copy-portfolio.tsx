"use client";

import { ArrowLeft, ChevronDown, Minus, Pause, Pencil, Play, Plus, Share2, Square } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { Fragment, useMemo, useState } from "react";
import { cn } from "cn";

import { CopyFundsRecords, OrderFills } from "@/components/copy/copy-accounting-history";
import { copyOrderPresentation } from "@/components/copy/copy-order-labels";
import { ModeBadge } from "@/components/shell/mode-badge";
import { CopyCompare } from "@/components/copy/copy-compare";
import { CopySparkline } from "@/components/copy/portfolio-parts";
import { SkelBar, SkelCircle } from "@/components/page";
import { TraderAvatar, boardName } from "@/components/discover/board-bits";
import { CoinIcon } from "@/components/traders/coin-icon";
import { RoiPill } from "@/components/traders/bits";
import { DataList } from "@/components/ui/data-list";
import { useIsDesktop } from "@/lib/use-is-desktop";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TablePager, usePaged } from "@/components/ui/table-pager";
import { TableSkeleton } from "@/components/ui/table-skeleton";
import { Modal } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { usePendingToast } from "@/lib/use-action-toast";
import { TradeShareDialog, copyCardSource, type TradeCardSource } from "@/components/trader/trade-share-dialog";
import { useI18n } from "@/i18n/provider";
import type { MessageKey } from "@/i18n/messages";
import { amountInput } from "@/lib/amount-input";
import { apiErrorCode } from "@/lib/api";
import { copyErrorText } from "@/lib/copy-error-text";
import { useCopyTexts } from "@/components/copy/live-copy-setup-dialogs";
import type { CopyPositionView, CopyStrategyView } from "@/lib/contracts";
import { copyDays, useAddCopyFunds, useCopyCommand, useCopyOrders, usePatchCopy, useWithdrawCopyFunds } from "@/lib/copy";
import { useTraderCards } from "@/lib/favorite-groups";
import { coinLabel, truncateAddress } from "@/lib/format";
import { TextButton } from "@/components/ui/text-button";

type Leader = { address: string; displayName: string | null; avatarUrl: string | null };

/** Names and avatars of the copied leaders (the discovery cards read). */
export function useLeaders(strategies: ReadonlyArray<Pick<CopyStrategyView, "leaderAddress">>): Map<string, Leader> {
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
  const chip = "chip-sm";
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      {s.status !== "active" ? <span className={cn(chip, "bg-raised text-muted-foreground")}>{t(`portfolio.copy.status.${s.status}` as MessageKey)}</span> : null}
      {s.reduceOnly && s.status !== "stopped" ? <span className={cn(chip, "bg-tag-warning text-tag-warning-foreground")}>{t("portfolio.copy.status.reduceOnly")}</span> : null}
    </span>
  );
}

function SideTag({ long }: { long: boolean }) {
  const { t } = useI18n();
  return (
    <span className={cn("whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-semibold", long ? "bg-tag-profit text-tag-profit-foreground" : "bg-tag-loss text-tag-loss-foreground")}>
      {t(long ? "portfolio.copy.long" : "portfolio.copy.short")}
    </span>
  );
}

const positionRoi = (p: CopyPositionView) => (p.unrealizedPnl !== null && p.notionalUsd ? p.unrealizedPnl / (Math.abs(p.size) * p.entryPx) : null);

/** A position on a phone copy card: coin and side, value, UPNL. */
function PositionLine({ p }: { p: CopyPositionView }) {
  const { format } = useI18n();
  return (
    <div className="grid grid-cols-[1.4fr_1fr_1fr] items-center gap-2 py-2 text-xs">
      <span className="flex items-center gap-2">
        <CoinIcon coin={p.coin} size={18} />
        <span className="font-semibold">{coinLabel(p.coin)}</span>
        <SideTag long={p.size > 0} />
      </span>
      <span className="num">{p.notionalUsd === null ? "—" : format.usd(p.notionalUsd, { digits: 2 })}</span>
      <span className={cn("num font-semibold", tone(p.unrealizedPnl))}>{p.unrealizedPnl === null ? "—" : format.usd(p.unrealizedPnl, { sign: true, digits: 2 })}</span>
    </div>
  );
}

/** A copy's positions as the site's dense table: coin and side (and the
 * share button), size and ROI from md, value, UPNL. */
function PositionsTable({ positions, onShare }: { positions: readonly CopyPositionView[]; onShare?: (p: CopyPositionView) => (() => void) | undefined }) {
  const { t, format } = useI18n();
  return (
    <Table dense className="text-xs" data-testid="copy-positions">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>{t("portfolio.copy.order.coin")}</TableHead>
          <TableHead className="hidden text-right md:table-cell">{t("portfolio.copy.order.size")}</TableHead>
          <TableHead className="text-right">{t("portfolio.copy.cols.equity")}</TableHead>
          <TableHead className="text-right">{t("portfolio.copy.cols.upnl")}</TableHead>
          <TableHead className="hidden text-right md:table-cell">{t("portfolio.copy.cols.roi")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {positions.map((p) => {
          const share = onShare?.(p);
          const roi = positionRoi(p);
          return (
            <TableRow key={p.coin}>
              <TableCell>
                <span className="flex items-center gap-2">
                  <CoinIcon coin={p.coin} size={18} />
                  <span className="font-semibold">{coinLabel(p.coin)}</span>
                  <SideTag long={p.size > 0} />
                  {share ? (
                    <button type="button" aria-haspopup="dialog" onClick={share} aria-label={t("trader.sharePosition")} title={t("trader.sharePosition")}
                      // 20 px drawn, 44 px to tap (the ::after reaches 12 px around it).
                      className="relative inline-flex size-5 items-center justify-center rounded-md text-muted-foreground outline-none after:absolute after:-inset-3 after:content-[''] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                      <Share2 className="size-3" />
                    </button>
                  ) : null}
                </span>
              </TableCell>
              <TableCell className="hidden text-right text-muted-foreground md:table-cell">{format.num(Math.abs(p.size), 4)}</TableCell>
              <TableCell className="text-right">{p.notionalUsd === null ? "—" : format.usd(p.notionalUsd, { digits: 2 })}</TableCell>
              <TableCell className={cn("text-right", tone(p.unrealizedPnl))}>{p.unrealizedPnl === null ? "—" : format.usd(p.unrealizedPnl, { sign: true, digits: 2 })}</TableCell>
              <TableCell className="hidden text-right md:table-cell">{roi === null ? "—" : <RoiPill value={roi} />}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** CopyDog's desktop list of copies, as the site's data table: trader,
 * days, positions, equity, curve, UPNL, P&L, ROI and the positions toggle
 * (the positions open under the row). */
export function CopyTable({ strategies, leaders, onSelect, sparklines, bare = false }: { strategies: CopyStrategyView[]; leaders: Map<string, Leader>; onSelect: (id: number) => void; sparklines?: Map<number, ReadonlyArray<number | null>>; bare?: boolean }) {
  const { t, format } = useI18n();
  const [open, setOpen] = useState<Set<number>>(new Set());
  const { rows, pager } = usePaged(strategies);
  return (
    <div className={cn(!bare && "orbit-card p-3")} data-testid="copy-table">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>{t("portfolio.copy.cols.trader")}</TableHead>
            <TableHead className="text-right">{t("portfolio.copy.cols.days")}</TableHead>
            <TableHead className="text-right">{t("portfolio.copy.cols.positions")}</TableHead>
            <TableHead className="text-right">{t("portfolio.copy.cols.equity")}</TableHead>
            <TableHead className="text-right">{t("portfolio.copy.cols.equityCurve")}</TableHead>
            <TableHead className="text-right">{t("portfolio.copy.cols.upnl")}</TableHead>
            <TableHead className="text-right">{t("portfolio.copy.cols.pnl")}</TableHead>
            <TableHead className="text-right">{t("portfolio.copy.cols.roi")}</TableHead>
            <TableHead className="w-14"><span className="sr-only">{t("portfolio.copy.showPositions")}</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((s) => {
            const leader = leaders.get(s.leaderAddress) ?? { address: s.leaderAddress, displayName: null, avatarUrl: null };
            const expanded = open.has(s.id);
            return (
              <Fragment key={s.id}>
                {/* The whole row opens the copy (mouse); the name is the keyboard / screen-reader control. */}
                <TableRow onClick={() => onSelect(s.id)} className="cursor-pointer">
                  <TableCell className="max-w-[16rem]">
                    <span className="flex min-w-0 items-center gap-2.5">
                      <TraderAvatar trader={leader} size={36} />
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelect(s.id);
                        }}
                        className="truncate rounded font-extrabold outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {boardName(leader)}
                      </button>
                      <StatusBadges s={s} />
                    </span>
                  </TableCell>
                  <TableCell className="text-right">{copyAge(s.createdAt, t)}</TableCell>
                  <TableCell className="text-right">{s.positions.length}</TableCell>
                  <TableCell className="text-right font-display text-[15px]">{s.equity === null ? "—" : format.usd(s.equity, { digits: 2 })}</TableCell>
                  <TableCell><span className="ml-auto flex w-[90px] justify-end"><CopySparkline points={sparklines?.get(s.id)} /></span></TableCell>
                  <TableCell className={cn("text-right", s.positions.length ? tone(s.unrealizedPnl) : "")}>
                    {s.positions.length && s.unrealizedPnl !== null ? format.usd(s.unrealizedPnl, { sign: true, digits: 2 }) : "—"}
                  </TableCell>
                  <TableCell className={cn("text-right font-display text-[15px]", tone(s.totalPnl))}>{s.totalPnl === null ? "—" : format.usd(s.totalPnl, { sign: true, digits: 2 })}</TableCell>
                  <TableCell className="text-right">{s.roiPct === null ? "—" : <RoiPill value={s.roiPct / 100} />}</TableCell>
                  <TableCell>
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
                          className="orbit-press inline-flex size-10 items-center justify-center rounded-full bg-card outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <ChevronDown className={cn("size-4 transition-transform duration-200", expanded && "rotate-180")} strokeWidth={2.4} />
                        </button>
                      ) : null}
                    </span>
                  </TableCell>
                </TableRow>
                {expanded ? (
                  <tr>
                    <td colSpan={9} className="p-0">
                      <div className="row-expansion mb-1.5 px-2 py-1"><PositionsTable positions={s.positions} /></div>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
      <TablePager {...pager} />
    </div>
  );
}

/** CopyDog's phone copy card: avatar, name + badges, equity, P&L + ROI, and the UPNL row with coins. */
export function CopyCards({ strategies, leaders, onSelect, sparklines }: { strategies: CopyStrategyView[]; leaders: Map<string, Leader>; onSelect: (id: number) => void; sparklines?: Map<number, ReadonlyArray<number | null>> }) {
  const { t, format } = useI18n();
  const [open, setOpen] = useState<number | null>(null);
  const { rows, pager } = usePaged(strategies);
  return (
    <div className="flex flex-col gap-3">
      {rows.map((s) => {
        const leader = leaders.get(s.leaderAddress) ?? { address: s.leaderAddress, displayName: null, avatarUrl: null };
        return (
          <div key={s.id} className="orbit-card">
            <button type="button" onClick={() => onSelect(s.id)} className="flex w-full items-center gap-3 p-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <TraderAvatar trader={leader} size={44} />
              <span className="flex min-w-0 flex-1 flex-col overflow-hidden">
                <span className="truncate text-[0.9375rem] font-bold">{boardName(leader)}</span>
                <span className="mt-1 flex min-w-0 items-center gap-1.5">
                  <span className="num text-xs text-muted-foreground">{s.equity === null ? "—" : format.usd(s.equity, { digits: 2 })}</span>
                  <StatusBadges s={s} />
                </span>
              </span>
              {(sparklines?.get(s.id)?.filter((v) => v !== null).length ?? 0) > 1 ? <CopySparkline points={sparklines?.get(s.id)} width={56} height={34} className="shrink-0" /> : null}
              <span className="flex flex-col items-end gap-1">
                <span className={cn("num text-[0.9375rem] font-bold", tone(s.totalPnl))}>{s.totalPnl === null ? "—" : format.usd(s.totalPnl, { sign: true, digits: 2 })}</span>
                {s.roiPct === null ? null : <RoiPill value={s.roiPct / 100} />}
              </span>
            </button>
            <div className="flex items-center gap-2 border-t-2 border-dotted border-border px-4 py-2.5 text-xs">
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
                    // 44 px to tap; the row keeps its height.
                    className="-my-2 -mr-2 inline-flex size-11 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="inline-flex size-7 items-center justify-center rounded-full bg-raised">
                      <ChevronDown className={cn("size-4 transition-transform", open === s.id && "rotate-180")} />
                    </span>
                  </button>
                </>
              ) : (
                <span className="text-muted-foreground">{t("portfolio.copy.noOpenPositions")}</span>
              )}
            </div>
            {open === s.id ? <div className="border-t-2 border-dotted border-border px-4">{s.positions.map((p) => <PositionLine key={p.coin} p={p} />)}</div> : null}
          </div>
        );
      })}
      <TablePager {...pager} className="orbit-card border-t-0" />
    </div>
  );
}

/** How long a copy has run: 「今天開始」 on its first day, never 「0 天」. */
export function copyAge(createdAt: string, t: ReturnType<typeof useI18n>["t"]): string {
  const days = copyDays(createdAt);
  return days < 1 ? t("portfolio.copy.startedToday") : t("portfolio.copy.daysShort", { count: days });
}

/** A paper copy command's failure in words (copyErrorText): the paper
 * codes' own text, busy or rate limited, else `fallback` (never one line for
 * every action). */
export function usePaperCopyErrorText() {
  const { t } = useI18n(), texts = useCopyTexts();
  return (err: unknown, fallback: MessageKey) => copyErrorText(texts, err, { fallback: t(fallback),
    codes: { copy_paused: t("trader.copy.errors.paused"), copy_not_open: t("trader.copy.errors.disabled"), copy_disabled: t("trader.copy.errors.disabled") } });
}

/** One copy: CopyDog's account view (your copy, P&L, ROI, capital, equity, days, direction), its actions, settings, positions and paper orders. */
export function CopyDetail({ strategy: s, leader, balance, onBack }: { strategy: CopyStrategyView; leader: Leader; balance: number; onBack: () => void }) {
  const { t, format } = useI18n(), paperCopyErrorText = usePaperCopyErrorText();
  const command = useCopyCommand();
  const toast = useToast();
  const [orderPages, setOrderPages] = useState<string[]>([]);
  const orders = useCopyOrders(s.id, orderPages.at(-1));
  const desktop = useIsDesktop();
  const positions = usePaged(s.positions);
  // The order whose fills are open (one at a time).
  const [openOrder, setOpenOrder] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"stop" | "edit" | "funds" | "withdraw" | null>(null);
  const [card, setCard] = useState<TradeCardSource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = s.status !== "stopped";
  const run = async (c: "pause" | "resume") => {
    setError(null);
    try {
      await command.mutateAsync({ id: s.id, command: c });
      toast.success(t(c === "pause" ? "toast.copy.paused" : "toast.copy.resumed"));
    } catch (err) {
      // Its own words (web audit L7), not the edit dialog's.
      const line = paperCopyErrorText(err, "portfolio.copy.actions.failed");
      setError(line); toast.error(line);
    }
  };
  const stat = (label: string, value: React.ReactNode, cls = "") => (
    <div className="rounded-xl bg-raised/50 p-3">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={cn("num mt-1 text-[0.9375rem] font-bold", cls)}>{value}</p>
    </div>
  );
  return (
    <div className="detail-arrive flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        {/* The trader page's phone back button. */}
        <button type="button" onClick={onBack} aria-label={t("portfolio.copy.detail.back")} className="orbit-press relative inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-raised outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <ArrowLeft className="size-5" strokeWidth={2.4} />
        </button>
        <TraderAvatar trader={leader} size={40} />
        <div className="min-w-0">
          <Link href={`/trader/${s.leaderAddress}`} className="flex items-center gap-2 text-base font-bold hover:underline">
            {boardName(leader)}
          </Link>
          <p className="num text-xs text-muted-foreground">{truncateAddress(s.leaderAddress)}</p>
        </div>
        <StatusBadges s={s} />
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
        {stat(t("portfolio.copy.detail.totalPnl"), s.totalPnl === null ? "—" : format.usd(s.totalPnl, { sign: true, digits: 2 }), tone(s.totalPnl))}
        {stat(t("portfolio.copy.detail.roi"), s.roiPct === null ? "—" : format.pct(s.roiPct / 100, { sign: true, digits: 2 }), tone(s.roiPct))}
        {stat(t("portfolio.copy.detail.initialCapital"), format.usd(s.allocated, { digits: 2 }))}
        {stat(t("portfolio.copy.detail.equity"), s.equity === null ? "—" : format.usd(s.equity, { digits: 2 }))}
        {stat(t("portfolio.copy.detail.copying"), copyAge(s.createdAt, t))}
        {stat(t("portfolio.copy.detail.direction"), t(s.settings.direction === "same" ? "portfolio.copy.detail.same" : "portfolio.copy.detail.counter"))}
      </div>

      {live ? (
        <div className="flex flex-wrap gap-2">
          {s.status === "paused" ? (
            <Button variant="secondary" onClick={() => run("resume")} loading={command.isPending}>
              <Play /> {t("portfolio.copy.actions.resume")}
            </Button>
          ) : s.status === "active" ? (
            <Button variant="secondary" onClick={() => run("pause")} loading={command.isPending}>
              <Pause /> {t("portfolio.copy.actions.pause")}
            </Button>
          ) : null}
          <Button variant="secondary" onClick={() => setDialog("edit")} disabled={s.status === "stopping"}>
            <Pencil /> {t("portfolio.copy.actions.edit")}
          </Button>
          <Button variant="secondary" onClick={() => setDialog("funds")} disabled={s.status === "stopping"}>
            <Plus /> {t("portfolio.copy.actions.addFunds")}
          </Button>
          <Button variant="secondary" onClick={() => setDialog("withdraw")} disabled={s.status === "stopping"}>
            <Minus /> {t("copyUpdates.withdrawTitle")}
          </Button>
          <Button variant="secondary" className="text-negative" onClick={() => setDialog("stop")} disabled={s.status === "stopping"}>
            <Square /> {t("portfolio.copy.actions.stop")}
          </Button>
        </div>
      ) : null}
      {error ? <p role="alert" className="text-xs font-semibold text-negative">{error}</p> : null}

      <CopyCompare strategy={s} traderName={boardName(leader)} />

      <div className="grid gap-4 md:grid-cols-[1fr_1.4fr]">
        <section className="orbit-card p-4">
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
              [t("portfolio.copy.detail.fees"), format.usd(s.fees ? -s.fees : 0, { digits: 2 })],
              [t("portfolio.copy.detail.funding"), format.usd(s.funding ? -s.funding : 0, { digits: 2 })],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="num font-semibold">{v}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section className="orbit-card">
          <h3 className="border-b-2 border-dotted border-border px-4 py-3 text-sm font-bold">{t("portfolio.copy.detail.positions")}</h3>
          {s.positions.length ? <div className="px-2"><PositionsTable positions={positions.rows} onShare={(p) => (p.unrealizedPnl === null ? undefined : () => setCard(copyCardSource("position", { strategyId: s.id, coin: p.coin }, coinLabel(p.coin))))} /></div> : <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t("portfolio.copy.noOpenPositions")}</p>}
          <TablePager {...positions.pager} />
        </section>
      </div>

      <section className="orbit-card">
        <h3 className="border-b-2 border-dotted border-border px-4 py-3 text-sm font-bold">{t("portfolio.copy.detail.ordersTitle")}</h3>
        {orders.data && orders.data.items.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <p className="text-sm font-bold">{t("portfolio.copy.detail.noOrders")}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t("portfolio.copy.detail.noOrdersDesc")}</p>
          </div>
        ) : desktop === false ? (
          <DataList data-testid="paper-orders-mobile" className="px-4">
            {(orders.data?.items ?? []).map((o) => {
              const presentation = copyOrderPresentation(o, t);
              const expanded = openOrder === o.id;
              return <li key={o.id} className="py-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-2 font-semibold"><CoinIcon coin={o.coin} size={18} />{coinLabel(o.coin)}</span>
                  <span>
                    <span className={o.side === "B" ? "text-positive" : "text-negative"}>{t(o.side === "B" ? "portfolio.copy.order.buy" : "portfolio.copy.order.sell")}</span>
                    <span className="ml-1.5 text-muted-foreground">{t(`portfolio.copy.order.leg.${o.leg}` as MessageKey)}</span>
                  </span>
                </div>
                <p className={cn("mt-2 font-semibold", presentation.tone)}>{presentation.status}</p>
                {presentation.reason ? <p className="mt-1 break-words text-muted-foreground">{presentation.reason}</p> : null}
                <button type="button" aria-expanded={expanded} aria-controls={`paper-order-${o.id}-details`}
                  onClick={() => setOpenOrder((id) => id === o.id ? null : o.id)}
                  className="mt-2 inline-flex min-h-11 items-center gap-2 rounded-full px-3 font-semibold outline-none transition-colors hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring">
                  {t("portfolio.copy.detail.showFills")}
                  <ChevronDown className={cn("size-4 transition-transform", expanded && "rotate-180")} />
                </button>
                {expanded ? <div id={`paper-order-${o.id}-details`} className="row-expansion mt-2 px-3 py-3">
                  <dl className="mb-3 grid gap-2">
                    {[
                      [t("portfolio.copy.order.time"), format.dateTime(o.createdAt)],
                      [t("portfolio.copy.order.size"), format.num(o.filledSize || o.size, 5)],
                      [t("portfolio.copy.order.price"), o.avgPx === null ? "—" : format.price(o.avgPx)],
                    ].map(([label, value]) => <div key={label} className="flex flex-wrap justify-between gap-2"><dt className="text-muted-foreground">{label}</dt><dd className="num font-semibold">{value}</dd></div>)}
                  </dl>
                  <OrderFills strategyId={s.id} orderId={o.id} />
                </div> : null}
              </li>;
            })}
          </DataList>
        ) : (
          <div className="cd-tables px-2">
            <Table dense className="text-xs" data-testid="paper-orders">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t("portfolio.copy.order.time")}</TableHead>
                  <TableHead>{t("portfolio.copy.order.coin")}</TableHead>
                  <TableHead>{t("portfolio.copy.order.side")}</TableHead>
                  <TableHead className="text-right">{t("portfolio.copy.order.size")}</TableHead>
                  <TableHead className="text-right">{t("portfolio.copy.order.price")}</TableHead>
                  <TableHead>{t("portfolio.copy.order.status")}</TableHead>
                  <TableHead className="row-action"><span className="sr-only">{t("portfolio.copy.detail.showFills")}</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(orders.data?.items ?? []).map((o) => {
                  const presentation = copyOrderPresentation(o, t);
                  return (
                  <Fragment key={o.id}>
                  <TableRow data-state={openOrder === o.id ? "selected" : undefined} className="cursor-pointer" onClick={() => setOpenOrder((id) => (id === o.id ? null : o.id))}>
                    <TableCell className="text-muted-foreground">{format.dateTime(o.createdAt)}</TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-2 align-middle font-semibold"><CoinIcon coin={o.coin} size={18} />{coinLabel(o.coin)}</span>
                    </TableCell>
                    <TableCell>
                      <span className={o.side === "B" ? "text-positive" : "text-negative"}>{t(o.side === "B" ? "portfolio.copy.order.buy" : "portfolio.copy.order.sell")}</span>
                      <span className="ml-1.5 text-xs text-muted-foreground">{t(`portfolio.copy.order.leg.${o.leg}` as MessageKey)}</span>
                    </TableCell>
                    <TableCell className="text-right">{format.num(o.filledSize || o.size, 5)}</TableCell>
                    <TableCell className="text-right">{o.avgPx === null ? "—" : format.price(o.avgPx)}</TableCell>
                    <TableCell>
                      <span className={presentation.tone}>
                        {presentation.status}
                      </span>
                      {presentation.reason ? <span className="mt-0.5 block text-xs text-muted-foreground">{presentation.reason}</span> : null}
                    </TableCell>
                    <TableCell className="row-action">
                      <button type="button" aria-expanded={openOrder === o.id} aria-label={t("portfolio.copy.detail.showFills")}
                        onClick={(e) => { e.stopPropagation(); setOpenOrder((id) => (id === o.id ? null : o.id)); }}
                        className="inline-flex size-9 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-raised-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                        <ChevronDown className={cn("size-4 transition-transform", openOrder === o.id && "rotate-180")} />
                      </button>
                    </TableCell>
                  </TableRow>
                  {openOrder === o.id ? (
                    <tr>
                      <td colSpan={7} className="p-0">
                        <div className="row-expansion mb-1.5 px-4 py-3"><OrderFills strategyId={s.id} orderId={o.id} /></div>
                      </td>
                    </tr>
                  ) : null}
                  </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
        {/* Ten a page from the api (cursor: the last order above), the
            site's one pager at the card's foot. */}
        <TablePager
          page={orderPages.length}
          hasNext={Boolean(orders.data?.hasMore && orders.data.previousCursor)}
          busy={orders.isPlaceholderData}
          onPage={(next) => setOrderPages((pages) => (next < pages.length ? pages.slice(0, next) : orders.data?.previousCursor ? [...pages, orders.data.previousCursor] : pages))}
        />
      </section>

      {orders.isError ? <p role="status" className="text-xs text-negative">{t("copyUpdates.historyError")} <TextButton busy={orders.isFetching} onClick={() => void orders.refetch()}>{t("copyUpdates.retry")}</TextButton></p> : null}
      <CopyFundsRecords strategyId={s.id} />
      <StopDialog strategy={s} open={dialog === "stop"} onClose={() => setDialog(null)} />
      <EditDialog strategy={s} open={dialog === "edit"} onClose={() => setDialog(null)} />
      <FundsDialog strategy={s} balance={balance} open={dialog === "funds"} onClose={() => setDialog(null)} />
      <WithdrawDialog strategy={s} open={dialog === "withdraw"} onClose={() => setDialog(null)} />
      {card ? <TradeShareDialog source={card} onClose={() => setCard(null)} /> : null}
    </div>
  );
}

/** CopyDog's 停止跟單: with open positions it's 停止並平倉 (they are closed). */
function StopDialog({ strategy: s, open, onClose }: { strategy: CopyStrategyView; open: boolean; onClose: () => void }) {
  const { t } = useI18n(), paperCopyErrorText = usePaperCopyErrorText();
  const command = useCopyCommand();
  const toast = useToast(), pending = usePendingToast();
  const [error, setError] = useState<string | null>(null);
  const n = s.positions.length;
  return (
    <Modal open={open} onOpenChange={(o) => !o && onClose()} title={t("portfolio.copy.stop.title")} badge={<ModeBadge mode="paper" />}>
      <div className="flex flex-col gap-5 p-5">
        <p className="text-sm text-muted-foreground">{n ? t("portfolio.copy.stop.withPositions", { count: n }) : t("portfolio.copy.stop.noPositions")}</p>
        {error ? <p role="alert" className="text-xs font-semibold text-negative">{error}</p> : null}
        <div className="grid grid-cols-2 gap-3">
          <Button variant="secondary" onClick={onClose}>{t("portfolio.copy.stop.cancel")}</Button>
          <Button
           
            className="bg-negative text-primary-foreground hover:bg-negative/90"
            loading={command.isPending}
            onClick={async () => {
              setError(null);
              try {
                await pending(command.mutateAsync({ id: s.id, command: "stop" }), t("toast.copy.stopping"));
                toast.success(t("toast.copy.stopped"));
                onClose();
              } catch (err) {
                const line = paperCopyErrorText(err, "portfolio.copy.stop.failed");
                setError(line); toast.error(line);
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
      <input id={id} inputMode="decimal" placeholder="0" value={value} onChange={(e) => onChange(amountInput(e.target.value, value).slice(0, 12))} className="num w-full bg-transparent text-lg font-semibold outline-none" />
    </div>
  );
}

/** CopyDog's 跟單交易設定: max allocation, and the amount per trade unless ratio. Saves a new version. */
function EditDialog({ strategy: s, open, onClose }: { strategy: CopyStrategyView; open: boolean; onClose: () => void }) {
  const { t, format } = useI18n();
  const patch = usePatchCopy();
  const toast = useToast();
  const [mode, setMode] = useState(s.settings.sizingMode);
  const [maxAlloc, setMaxAlloc] = useState(String(Math.floor(s.settings.maxTotalExposureUsd ?? s.allocated * 5)));
  const [perTrade, setPerTrade] = useState(s.settings.perTradeUsd ? String(Math.floor(s.settings.perTradeUsd)) : "");
  const [error, setError] = useState<string | null>(null);
  const max = Number.parseFloat(maxAlloc);
  const per = Number.parseFloat(perTrade);
  const invalid = !(max > 0) || (mode === "fixed" && (!(per > 0) || per > max));
  return (
    <Modal open={open} onOpenChange={(o) => !o && onClose()} title={t("portfolio.copy.edit.title")} badge={<ModeBadge mode="paper" />}>
      <div className="flex flex-col gap-5 p-5">
        <div role="radiogroup" className="grid grid-cols-2 gap-1 rounded-full border border-border-strong bg-raised p-1">
          {(["fixed", "ratio"] as const).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)} className={cn("min-h-11 rounded-full text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring", mode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground")}>
              {t(m === "fixed" ? "portfolio.copy.edit.fixed" : "portfolio.copy.edit.ratio")}
            </button>
          ))}
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor="edit-max" className="flex justify-between text-sm font-semibold">
            {t("portfolio.copy.edit.maxAllocation")}
            {/* The cap on all its positions together; the copy's own money is said apart from it. */}
            <span className="text-xs font-medium text-muted-foreground" data-testid="edit-budget">{t("portfolio.copy.edit.budget", { amount: format.num(s.allocated, 2) })}</span>
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
          size="cta"
          loading={patch.isPending}
          disabled={!patch.isPending && invalid}
          onClick={async () => {
            setError(null);
            try {
              await patch.mutateAsync({ id: s.id, patch: { sizingMode: mode, maxTotalExposureUsd: max, perTradeUsd: mode === "fixed" ? per : s.settings.perTradeUsd } });
              toast.success(t("toast.copy.edited"));
              onClose();
            } catch {
              setError(t("portfolio.copy.edit.failed")); toast.error(t("portfolio.copy.edit.failed"));
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
  const toast = useToast();
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const value = Number.parseFloat(amount);
  const invalid = !(value > 0) || value > balance;
  return (
    <Modal open={open} onOpenChange={(o) => !o && onClose()} title={t("portfolio.copy.funds.title")} badge={<ModeBadge mode="paper" />}>
      <div className="flex flex-col gap-4 p-5">
        <label htmlFor="funds-amount" className="flex justify-between text-sm font-semibold">
          USDC
          <span className="text-xs font-medium text-muted-foreground">{t("portfolio.copy.funds.available", { balance: format.num(balance, 2) })}</span>
        </label>
        <AmountInput id="funds-amount" value={amount} onChange={setAmount} invalid={amount !== "" && invalid} />
        <div className="grid grid-cols-4 gap-2">
          {[10, 25, 50, 100].map((p) => (
            <button key={p} type="button" onClick={() => setAmount(String(Math.floor((balance * p) / 100)))} className="h-11 rounded-full border border-border-strong bg-raised text-sm font-semibold outline-none hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring">
              {p === 100 ? t("trader.copy.max") : `${p}%`}
            </button>
          ))}
        </div>
        {error ? <p role="alert" className="text-xs font-semibold text-negative">{error}</p> : null}
        <Button
          size="cta"
          loading={add.isPending}
          disabled={!add.isPending && invalid}
          onClick={async () => {
            setError(null);
            try {
              await add.mutateAsync({ id: s.id, amountUsd: value });
              toast.success(t("toast.copy.toppedUp", { amount: format.num(value, 2) }));
              setAmount("");
              onClose();
            } catch (err) {
              const line = apiErrorCode(err) === "insufficient_balance" ? t("trader.copy.errors.exceedsBalance") : t("portfolio.copy.funds.failed");
              setError(line); toast.error(line);
            }
          }}
        >
          {t("portfolio.copy.funds.confirm")}
        </Button>
      </div>
    </Modal>
  );
}

export function WithdrawDialog({ strategy: s, open, onClose }: { strategy: CopyStrategyView; open: boolean; onClose: () => void }) {
  const { t, format } = useI18n();
  const withdraw = useWithdrawCopyFunds();
  const toast = useToast(), whilePending = usePendingToast();
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const pending = withdraw.pendingOperations.filter((body) => body.id === s.id);
  const available = s.freeCollateralUsd;
  const value = Number.parseFloat(amount);
  const invalid = !(value > 0) || available == null || value > available;
  return <Modal open={open} onOpenChange={(o) => !o && onClose()} title={t("copyUpdates.withdrawTitle")} badge={<ModeBadge mode="paper" />}>
    <div className="flex flex-col gap-4 p-5">
      <p className="text-xs text-muted-foreground">{t("copyUpdates.withdrawHint")}</p>
      <label htmlFor="withdraw-amount" className="flex justify-between text-sm font-semibold">USDC <span className="text-xs text-muted-foreground">{t("copyUpdates.available")}: {available == null ? "—" : format.usd(available, { digits: 2 })}</span></label>
      {pending.map((body) => <Button key={body.amountUsd} variant="secondary" loading={withdraw.isPending && withdraw.variables?.amountUsd === body.amountUsd} disabled={withdraw.isPending && withdraw.variables?.amountUsd !== body.amountUsd} onClick={async () => {
        setError(null);
        try { await whilePending(withdraw.mutateAsync(body), t("toast.copy.withdrawing")); toast.success(t("toast.copy.withdrawn", { amount: format.num(body.amountUsd, 2) })); setAmount(""); onClose(); }
        catch { setError(t("copyUpdates.withdrawUnknown")); toast.error(t("copyUpdates.withdrawUnknown")); }
      }}>{t("copyUpdates.retryWithdrawal", { amount: format.usd(body.amountUsd, { digits: 2 }) })}</Button>)}
      <AmountInput id="withdraw-amount" value={amount} onChange={setAmount} invalid={amount !== "" && invalid} />
      {error ? <p role="alert" className="text-xs text-negative">{error}</p> : null}
      <Button size="cta" loading={withdraw.isPending && pending.length === 0} disabled={!(withdraw.isPending && pending.length === 0) && (invalid || withdraw.isPending || pending.length > 0)} onClick={async () => {
        setError(null);
        try {
          await whilePending(withdraw.mutateAsync({ id: s.id, amountUsd: value }), t("toast.copy.withdrawing"));
          toast.success(t("toast.copy.withdrawn", { amount: format.num(value, 2) }));
          setAmount("");
          onClose();
        } catch (error) {
          const line = t(apiErrorCode(error) ? "copyUpdates.withdrawError" : "copyUpdates.withdrawUnknown");
          setError(line); toast.error(line);
        }
      }}>{withdraw.isPending ? (t("copyUpdates.processing")) : (t("copyUpdates.withdrawConfirm"))}</Button>
    </div>
  </Modal>;
}

/** The copy list while /me/copy loads: CopyTable's header over raised rows
 * (avatar, name and figure bars) on desktop, CopyCards' cards on phones. */
export function CopyListSkeleton({ phone = false, rows = 2 }: { phone?: boolean; rows?: number }) {
  const { t } = useI18n();
  if (phone) {
    return (
      <div aria-hidden="true" className="ui-skeleton flex flex-col gap-3">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="orbit-card">
            <div className="flex items-center gap-3 p-4">
              <SkelCircle className="size-11" />
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <SkelBar line="h-[22px]" className="h-3.5 w-28" />
                <SkelBar line="h-[18px]" className="h-2.5 w-20" />
              </span>
              <span className="flex flex-col items-end gap-1">
                <SkelBar line="h-[22px]" className="h-3.5 w-16" />
                <SkelBar className="h-[22px] w-14 rounded-xl" />
              </span>
            </div>
            <div className="flex h-[38px] items-center gap-2 border-t-2 border-dotted border-border px-4">
              <SkelBar className="h-2.5 w-24" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  const heads = ["days", "positions", "equity", "equityCurve", "upnl", "pnl", "roi"] as const;
  return (
    <TableSkeleton
      rows={rows}
      columns={[
        { label: t("portfolio.copy.cols.trader"), bar: "w-32" },
        ...heads.map((h) => ({ label: t(`portfolio.copy.cols.${h}`), right: true })),
        { className: "w-14", bar: "ml-auto size-8" },
      ]}
    />
  );
}
