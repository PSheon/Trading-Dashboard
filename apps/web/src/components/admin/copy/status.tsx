"use client";

import { Link, usePathname, useRouter } from "@/i18n/navigation";
import { useSearchParams } from "next/navigation";
import { Fragment, useMemo, useState } from "react";
import { ArrowRight, ChevronDown, Search } from "lucide-react";
import { cn } from "cn";
import { COPY_STUCK_ORDER_ATTEMPTS as STUCK_ORDER_ATTEMPTS, copyControlCommandEnum, type CopyControlCommand } from "@trading-dashboard/shared/contracts";

import { AdminSubTabs } from "@/components/admin/admin-shell";
import { AdminCard, Notice } from "@/components/admin/ui";
import { ErrorState, PanelSkeleton, SectionHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TableSkeleton } from "@/components/ui/table-skeleton";
import { useI18n } from "@/i18n/provider";
import { signalLagSeconds, useAdminCopyExposure, useAdminCopyOverview, useAdminCopyStrategies } from "@/lib/admin-copy";
import { usePermission } from "@/lib/auth";
import type { AdminCopyStrategyView } from "@/lib/contracts";
import { coinLabel, signClass, truncateAddress } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { ControlDialog, type ControlRequest } from "./control-dialog";
import { Chip, ControlButtons, ControlState, StrategyStatus } from "./shared";
import { StrategyDetailBody } from "./strategies";

export const COPY_SUB_TABS = {
  "/admin/copy": "admin.sub.copyStatus",
  "/admin/copy/orders": "admin.sub.copyOrders",
  "/admin/copy/risk": "admin.sub.copyRisk",
  "/admin/copy/testnet": "admin.sub.copyTestnet",
} as const;

const STOPS = copyControlCommandEnum.filter((c) => c !== "resume");
/** A signal waiting this long means opens are about to go stale (the default maxSignalAgeSeconds is 120). */
const LAG_WARN_SECONDS = 60;

/**
 * 跟單 › 狀態與命令 (C-AdminNew-Copy): the platform's stop state and its five
 * commands, then one table of users' exposure where each row has its own
 * 停止… commands and opens to that user's copies, each with its 帳本 (the
 * ledger drawer, also reached by ?strategy=). One confirmation dialog serves
 * the platform and every user.
 */
export function AdminCopyStatus() {
  const { t, format } = useI18n();
  const now = useNow();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const overview = useAdminCopyOverview();
  const exposure = useAdminCopyExposure();
  const strategies = useAdminCopyStrategies({});
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [picked, setPicked] = useState<{ userId: number | null; command: CopyControlCommand } | null>(null);
  const ledger = /^[1-9]\d{0,9}$/.test(params.get("strategy") ?? "") ? Number(params.get("strategy")) : null;
  const setLedger = (id: number | null) => router.replace(id === null ? pathname : `${pathname}?strategy=${id}`, { scroll: false });

  const d = overview.data;
  const users = useMemo(() => exposure.data?.items ?? [], [exposure.data]);
  const byUser = useMemo(() => {
    const map = new Map<number, AdminCopyStrategyView[]>();
    for (const s of strategies.data?.items ?? []) map.set(s.userId, [...(map.get(s.userId) ?? []), s]);
    return map;
  }, [strategies.data]);
  const unrealized = (userId: number) => {
    const list = byUser.get(userId)?.filter((s) => s.status !== "stopped");
    if (!list) return undefined;
    return list.some((s) => s.unrealizedPnl === null) ? null : list.reduce((a, s) => a + (s.unrealizedPnl ?? 0), 0);
  };
  const totalExposure = exposure.data ? (users.some((u) => u.exposureUsd === null) ? null : users.reduce((a, u) => a + (u.exposureUsd ?? 0), 0)) : null;
  const q = query.trim().toLowerCase();
  const shown = q ? users.filter((u) => (u.userEmail ?? "").toLowerCase().includes(q) || String(u.userId) === q.replace(/^#/, "")) : users;

  let request: ControlRequest | null = null;
  if (picked && d && picked.userId === null) {
    request = { target: { scope: "platform" }, targetLabel: t("copyAdmin.dialog.allUsers"), command: picked.command, revision: d.platform.revision,
      impact: { strategies: users.reduce((a, u) => a + u.strategies, 0), users: users.length, exposureUsd: totalExposure } };
  } else if (picked && picked.userId !== null) {
    const u = users.find((x) => x.userId === picked.userId);
    if (u) request = { target: { scope: "user", userId: u.userId }, targetLabel: u.userEmail ?? `#${u.userId}`, command: picked.command, revision: u.control.revision,
      impact: { strategies: u.strategies, exposureUsd: u.exposureUsd } };
  }

  let platform: React.ReactNode;
  if (overview.isError && !d) platform = <AdminCard><ErrorState message={overview.error.message} onRetry={() => overview.refetch()} /></AdminCard>;
  else if (!d) platform = <PanelSkeleton rows={2} />;
  else {
    const lag = now ? signalLagSeconds(d.outbox.oldestPendingAt, now) : null;
    const failed24h = (d.orders24h.rejected ?? 0) + (d.orders24h.cancelled ?? 0);
    const orders24h = Object.values(d.orders24h).reduce((a, n) => a + (n ?? 0), 0);
    platform = (
      <AdminCard
        aria-labelledby="copy-platform-title"
        title={<span className="flex flex-wrap items-center gap-2.5"><span id="copy-platform-title">{t("copyAdmin.platform.title")}</span><ControlState state={d.platform} /><Chip tone="info">{t(`copyAdmin.mode.${d.mode}`)}</Chip></span>}
        action={
          <span className="num type-caption text-right">
            {t("admin.copy.summary", { revision: d.platform.revision, version: d.riskPolicyVersion, backlog: d.outbox.pending, orders: orders24h, failed: failed24h })}
            {lag !== null && lag > LAG_WARN_SECONDS ? <span className="text-negative"> · {t("copyAdmin.backlog.lag")} {format.duration(lag)}</span> : null}
          </span>
        }
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <ControlButtons size="default" state={d.platform} onPick={(command) => setPicked({ userId: null, command })} />
          <p className="type-caption min-w-[16rem] flex-1">{t("admin.copy.commandsHint")}</p>
        </div>
      </AdminCard>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <AdminSubTabs tab="copy" labels={COPY_SUB_TABS} />
      {overview.isError && d ? <Notice>{t("copyAdmin.stale")}</Notice> : null}
      {platform}

      {d && (d.stuckOrders?.length ?? 0) > 0 ? (
        <AdminCard data-testid="copy-stuck-orders" aria-labelledby="copy-stuck-title" className="shadow-[0_0_0_2px_var(--negative)]"
          title={<span id="copy-stuck-title" className="flex items-center gap-2">{t("copyAdmin.stuck.title")}<Chip tone="bad">{format.num(d.stuckOrders!.length, 0)}</Chip></span>}>
          <p className="type-caption">{t("copyAdmin.stuck.hint", { attempts: STUCK_ORDER_ATTEMPTS })}</p>
          <ul className="divide-y-2 divide-dotted divide-border text-sm font-bold">
            {d.stuckOrders!.map((o) => (
              <li key={o.id} className="grid gap-x-6 gap-y-1 py-2.5 sm:grid-cols-[auto_1fr_auto]">
                <span className="num">{t("copyAdmin.stuck.order")} #{o.id} · {coinLabel(o.coin)} · {t(`copyAdmin.leg.${o.leg}`)}{o.reduceOnly ? ` · ${t("copyAdmin.stuck.reduceOnly")}` : ""}</span>
                <span className="min-w-0 break-words text-muted-foreground">{t("copyAdmin.stuck.error")}: {o.lastError ?? "—"}</span>
                <span className="num text-muted-foreground">
                  <button type="button" className="text-primary-text underline-offset-4 hover:underline" onClick={() => setLedger(o.strategyId)}>{t("copyAdmin.stuck.strategy")} #{o.strategyId}</button>
                  {" · "}{t("copyAdmin.stuck.attempts")}: <span className="text-negative">{o.attempts}</span>{" · "}{t("copyAdmin.stuck.since")} {format.dateTime(o.since)}
                </span>
              </li>
            ))}
          </ul>
        </AdminCard>
      ) : null}

      <section aria-labelledby="copy-users-title" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="copy-users-title" className="type-h2">{t("admin.copy.exposureTitle")}</h2>
          <label className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("admin.copy.searchUsers")} aria-label={t("admin.copy.searchUsers")}
              className="h-11 w-full rounded-full border-2 border-transparent bg-raised pr-4 pl-10 text-[15px] font-bold outline-none placeholder:text-subtle-foreground focus-visible:border-primary" />
          </label>
        </div>
        {exposure.isError && !exposure.data ? <ErrorState message={exposure.error.message} onRetry={() => exposure.refetch()} />
          : !exposure.data ? <TableSkeleton rows={3} columns={[{ label: t("copyAdmin.cols.user") }, { label: t("admin.copy.cols.strategies"), right: true, className: "hidden sm:table-cell" }, { label: t("admin.copy.cols.exposure"), right: true, className: "hidden sm:table-cell" }, { label: t("admin.copy.cols.unrealized"), right: true, className: "hidden md:table-cell" }, { label: t("copyAdmin.cols.status") }, {}]} />
          : shown.length === 0 ? <p className="rounded-[18px] bg-raised px-[18px] py-5 text-sm font-bold text-muted-foreground">{t(q ? "admin.copy.noMatch" : "copyAdmin.users.empty")}</p>
          : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t("copyAdmin.cols.user")}</TableHead>
                  <TableHead className="hidden text-right sm:table-cell">{t("admin.copy.cols.strategies")}</TableHead>
                  <TableHead className="hidden text-right sm:table-cell">{t("admin.copy.cols.exposure")}</TableHead>
                  <TableHead className="hidden text-right md:table-cell">{t("admin.copy.cols.unrealized")}</TableHead>
                  <TableHead>{t("copyAdmin.cols.status")}</TableHead>
                  <TableHead><span className="sr-only">{t("admin.copy.cols.actions")}</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((u) => {
                  const pnl = unrealized(u.userId);
                  const expanded = open === u.userId;
                  return (
                    <Fragment key={u.userId}>
                      <TableRow data-state={expanded ? "selected" : undefined}>
                        <TableCell className="max-w-[8.5rem] truncate sm:max-w-[16rem]">{u.userEmail ?? `#${u.userId}`}</TableCell>
                        <TableCell className="hidden text-right sm:table-cell">{format.num(u.strategies, 0)}</TableCell>
                        <TableCell className="hidden text-right sm:table-cell">{u.exposureUsd === null ? "—" : format.usd(u.exposureUsd, { digits: 2 })}</TableCell>
                        <TableCell className={cn("hidden text-right md:table-cell", signClass(pnl ?? null))}>{pnl === undefined || pnl === null ? "—" : format.usd(pnl, { digits: 2, sign: true })}</TableCell>
                        <TableCell><ControlState state={u.control} /></TableCell>
                        <TableCell className="text-right">
                          <span className="inline-flex items-center gap-1.5">
                            <StopMenu state={u.control} label={u.userEmail ?? `#${u.userId}`} onPick={(command) => setPicked({ userId: u.userId, command })} />
                            <Button variant="ghost" size="sm" aria-expanded={expanded} aria-controls={`copy-user-${u.userId}`} onClick={() => setOpen(expanded ? null : u.userId)}>
                              {t(expanded ? "admin.copy.collapse" : "admin.copy.expand")}
                            </Button>
                          </span>
                        </TableCell>
                      </TableRow>
                      {expanded ? (
                        <tr id={`copy-user-${u.userId}`}>
                          <td colSpan={6} className="p-0">
                            <UserStrategies strategies={byUser.get(u.userId)} loading={!strategies.data} coins={u.coins} onLedger={setLedger} />
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          )}
        {exposure.data?.pricedAt ? <p className="num type-caption text-right">{t("copyAdmin.users.pricedAt", { time: format.dateTime(exposure.data.pricedAt) })}</p> : null}
      </section>

      {d ? (
        <section aria-labelledby="copy-events-title" className="flex flex-col gap-2">
          <SectionHeader className="mb-0" title={<span id="copy-events-title">{t("copyAdmin.events.title")}</span>} />
          {d.events.length === 0 ? <p className="rounded-[18px] bg-raised px-[18px] py-5 text-sm font-bold text-muted-foreground">{t("copyAdmin.events.empty")}</p> : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t("copyAdmin.cols.time")}</TableHead>
                  <TableHead>{t("copyAdmin.cols.command")}</TableHead>
                  <TableHead>{t("copyAdmin.cols.scope")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("copyAdmin.cols.actor")}</TableHead>
                  <TableHead className="hidden sm:table-cell">{t("copyAdmin.cols.reason")}</TableHead>
                  <TableHead className="hidden text-right lg:table-cell">{t("copyAdmin.cols.effect")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.events.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="text-muted-foreground">{format.dateTime(e.createdAt)}</TableCell>
                    <TableCell>
                      {t(`copyAdmin.commands.${e.command}`)}
                      {e.reason ? <span className="mt-1 block max-w-[12rem] truncate text-xs text-muted-foreground sm:hidden">{e.reason}</span> : null}
                    </TableCell>
                    <TableCell>{t(`copyAdmin.scope.${e.scope}`)}{e.scope === "platform" ? "" : ` #${e.scopeId}`} · r{e.revision}</TableCell>
                    <TableCell className="hidden max-w-[12rem] truncate md:table-cell">{e.actorEmail ?? (e.actorUserId === null ? "—" : `#${e.actorUserId}`)}</TableCell>
                    <TableCell className="hidden max-w-[16rem] truncate text-muted-foreground sm:table-cell">{e.reason ?? "—"}</TableCell>
                    <TableCell className="hidden text-right lg:table-cell">{t("copyAdmin.events.effect", { cancelled: e.result.cancelledOrders, closed: e.result.closeOrders })}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>
      ) : null}

      <ControlDialog request={request} onClose={() => setPicked(null)} />
      <Drawer open={ledger !== null} onOpenChange={(next) => { if (!next) setLedger(null); }} title={ledger === null ? "" : t("copyAdmin.detail.title", { id: ledger })}>
        {ledger !== null ? <StrategyDetailBody id={ledger} /> : null}
      </Drawer>
    </div>
  );
}

/** 停止…: a user's stop commands (and resume once stopped), each with its permission. */
function StopMenu({ state, label, onPick }: { state: { pauseNewRisk: boolean; reduceOnly: boolean }; label: string; onPick: (command: CopyControlCommand) => void }) {
  const { t } = useI18n();
  const canPause = usePermission("execution.pause");
  const canResume = usePermission("execution.resume");
  const stopped = state.pauseNewRisk || state.reduceOnly;
  if (!canPause && !canResume) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" size="sm" aria-label={t("admin.copy.stopFor", { name: label })}>
          {t("admin.copy.stop")}
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        {STOPS.map((command) => (
          <DropdownMenuItem key={command} disabled={!canPause || (command === "pause_new_risk" && state.pauseNewRisk) || (command === "reduce_only" && state.reduceOnly)}
            className={command === "close_positions" ? "text-tag-alert-foreground" : undefined} onSelect={() => onPick(command)}>
            {t(`copyAdmin.commands.${command}`)}
          </DropdownMenuItem>
        ))}
        {canResume ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={!stopped} onSelect={() => onPick("resume")}>{t("copyAdmin.commands.resume")}</DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The expanded row: the user's copies on the row's grid, each with 帳本 →. */
function UserStrategies({ strategies, loading, coins, onLedger }: {
  strategies: AdminCopyStrategyView[] | undefined;
  loading: boolean;
  coins: { coin: string; netUsd: number }[];
  onLedger: (id: number) => void;
}) {
  const { t, format } = useI18n();
  return (
    <div className="row-expansion mb-1.5 flex flex-col gap-2 px-4 py-3 md:px-[18px]">
      <p className="type-th">{t("admin.copy.strategiesOf")}</p>
      {loading ? <p className="text-sm font-bold text-muted-foreground">{t("admin.copy.loading")}</p>
        : !strategies?.length ? <p className="text-sm font-bold text-muted-foreground">{t("copyAdmin.strategies.empty")}</p>
        : (
          <ul className="flex flex-col divide-y-2 divide-dotted divide-border">
            {strategies.map((s) => (
              <li key={s.id} className="grid items-center gap-x-4 gap-y-1 py-2 text-sm font-extrabold sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_auto_auto_auto]">
                <span className="min-w-0 truncate">
                  {t("admin.copy.follows")} <Link href={`/trader/${s.leaderAddress}`} className="num underline-offset-4 hover:underline">{truncateAddress(s.leaderAddress)}</Link>
                </span>
                <span className="text-muted-foreground">
                  {t(`copyAdmin.detail.directions.${s.settings.direction}`)} · {t(`copyAdmin.detail.sizings.${s.settings.sizingMode}`)}{s.settings.perTradeUsd === null ? "" : ` ${format.usd(s.settings.perTradeUsd, { digits: 0 })}`}
                </span>
                <span className="num">{t("admin.copy.equity")} {s.equity === null ? "—" : format.usd(s.equity, { digits: 2 })}</span>
                <span className="num text-muted-foreground">{t("admin.copy.ordersCount", { count: s.pendingOrders + s.tradesCopied })}</span>
                <StrategyStatus status={s.status} />
                <button type="button" onClick={() => onLedger(s.id)} className="inline-flex items-center gap-1 justify-self-start text-primary-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring sm:justify-self-end">
                  {t("admin.copy.ledger")}<ArrowRight className="size-4" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      {coins.length ? (
        <ul className="flex flex-wrap gap-1.5">
          {coins.map((c) => (
            <li key={c.coin} className="chip-sm bg-card"><span>{coinLabel(c.coin)}</span> <span className={c.netUsd >= 0 ? "text-positive" : "text-negative"}>{format.usd(c.netUsd, { compact: true, sign: true })}</span></li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
