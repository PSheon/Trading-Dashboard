"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { copyStrategyStatusEnum, type CopyStrategyStatus } from "@trading-dashboard/shared/contracts";

import { ErrorState, Panel, PanelSkeleton, SectionHeader } from "@/components/page";
import { Select } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useI18n } from "@/i18n/provider";
import { useAdminCopyStrategies, useAdminCopyStrategy } from "@/lib/admin-copy";
import type { AdminCopyStrategyView } from "@/lib/contracts";
import { coinLabel, signClass, truncateAddress } from "@/lib/format";
import { Chip, CopyAdminNav, OrdersTable, StrategyStatus } from "./shared";
import { TableSkeleton } from "@/components/ui/table-skeleton";


export function AdminCopyStrategies() {
  const { t, format } = useI18n();
  const [status, setStatus] = useState<CopyStrategyStatus | "">("");
  const strategies = useAdminCopyStrategies({ status });
  const items = strategies.data?.items;
  return (
    <div className="flex flex-col gap-4">
      <CopyAdminNav />
      <div className="flex flex-wrap items-center gap-2.5">
        <Select size="sm" label={t("copyAdmin.strategies.filter")} value={status} onValueChange={(value) => setStatus(value as CopyStrategyStatus | "")}
          options={[{ value: "", label: t("copyAdmin.strategies.all") }, ...copyStrategyStatusEnum.map((s) => ({ value: s, label: t(`copyAdmin.strategyStatus.${s}`) }))]} />
        {items ? <span className="num ml-auto text-xs text-muted-foreground">{t("copyAdmin.strategies.count", { count: items.length })}</span> : null}
      </div>
      <Panel className="overflow-hidden">
        {strategies.isError && !items ? <ErrorState message={strategies.error.message} onRetry={() => strategies.refetch()} />
          : !items ? <div className="p-3"><TableSkeleton rows={6} columns={[{}, {}, {}, { right: true }, { right: true }]} /></div>
          : items.length === 0 ? <p className="p-5 text-sm text-muted-foreground">{t("copyAdmin.strategies.empty")}</p>
          : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t("copyAdmin.cols.strategy")}</TableHead>
                  <TableHead>{t("copyAdmin.cols.user")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("copyAdmin.cols.leader")}</TableHead>
                  <TableHead>{t("copyAdmin.cols.status")}</TableHead>
                  <TableHead className="hidden text-right sm:table-cell">{t("copyAdmin.cols.allocated")}</TableHead>
                  <TableHead className="text-right">{t("copyAdmin.cols.equity")}</TableHead>
                  <TableHead className="hidden text-right sm:table-cell">{t("copyAdmin.cols.pnl")}</TableHead>
                  <TableHead className="hidden text-right lg:table-cell">{t("copyAdmin.cols.positions")}</TableHead>
                  <TableHead className="hidden text-right lg:table-cell">{t("copyAdmin.cols.pending")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell>
                      <Link href={`/admin/copy/strategies/${s.id}`} className="font-semibold underline decoration-border underline-offset-4">#{s.id}</Link>
                    </TableCell>
                    <TableCell className="max-w-[11rem] truncate">{s.userEmail ?? `#${s.userId}`}</TableCell>
                    <TableCell className="hidden font-mono text-xs md:table-cell">{truncateAddress(s.leaderAddress)}</TableCell>
                    <TableCell><StrategyFlags strategy={s} /></TableCell>
                    <TableCell className="hidden text-right sm:table-cell">{format.usd(s.allocated, { digits: 2 })}</TableCell>
                    <TableCell className="text-right">{s.equity === null ? "—" : format.usd(s.equity, { digits: 2 })}</TableCell>
                    <TableCell className={`hidden text-right sm:table-cell ${signClass(s.totalPnl)}`}>{s.totalPnl === null ? "—" : format.usd(s.totalPnl, { digits: 2, sign: true })}</TableCell>
                    <TableCell className="hidden text-right lg:table-cell">{s.positions.length}</TableCell>
                    <TableCell className="hidden text-right lg:table-cell">{s.pendingOrders}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
      </Panel>
    </div>
  );
}

function StrategyFlags({ strategy }: { strategy: AdminCopyStrategyView }) {
  const { t } = useI18n();
  return (
    <span className="inline-flex flex-wrap gap-1">
      <StrategyStatus status={strategy.status} />
      {strategy.reduceOnly ? <Chip tone="warn">{t("copyAdmin.state.reduceOnly")}</Chip> : null}
    </span>
  );
}

/** One copy: who, whom, its money, positions, every settings version, its orders with reasons and the ledger. */
export function AdminCopyStrategyDetail({ id }: { id: number }) {
  const { t, format } = useI18n();
  const detail = useAdminCopyStrategy(id);
  const d = detail.data;
  let body: React.ReactNode;
  if (detail.isError && !d) {
    body = <Panel><ErrorState message={detail.error.message} onRetry={() => detail.refetch()} /></Panel>;
  } else if (!d) {
    body = <PanelSkeleton tiles={4} rows={6} />;
  } else {
    const s = d.strategy;
    const facts: [string, React.ReactNode][] = [
      [t("copyAdmin.cols.user"), s.userEmail ?? `#${s.userId}`],
      [t("copyAdmin.cols.leader"), <Link key="l" href={`/trader/${s.leaderAddress}`} className="font-mono text-xs underline decoration-border underline-offset-4">{truncateAddress(s.leaderAddress)}</Link>],
      [t("copyAdmin.cols.allocated"), format.usd(s.allocated, { digits: 2 })],
      [t("copyAdmin.cols.equity"), s.equity === null ? "—" : format.usd(s.equity, { digits: 2 })],
      [t("copyAdmin.cols.pnl"), <span key="p" className={signClass(s.totalPnl)}>{s.totalPnl === null ? "—" : format.usd(s.totalPnl, { digits: 2, sign: true })}</span>],
      [t("copyAdmin.detail.exposure"), s.exposureUsd === null ? "—" : format.usd(s.exposureUsd, { digits: 2 })],
      [t("copyAdmin.detail.fees"), format.usd(s.fees, { digits: 2 })],
      [t("copyAdmin.detail.created"), format.dateTime(s.createdAt)],
    ];
    body = (
      <>
        <Panel className="p-5">
          <div className="mb-4 flex flex-wrap items-center gap-2.5">
            <h2 className="text-lg font-bold">{t("copyAdmin.detail.title", { id: s.id })}</h2>
            <StrategyFlags strategy={s} />
            <Chip>{t("copyAdmin.detail.version", { version: s.version })}</Chip>
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm md:grid-cols-4">
            {facts.map(([label, value]) => (
              <div key={label} className="min-w-0">
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="num mt-1 truncate font-semibold">{value}</dd>
              </div>
            ))}
          </dl>
        </Panel>

        <section>
          <SectionHeader title={t("copyAdmin.detail.positions")} />
          <Panel className="overflow-hidden">
            {s.positions.length === 0 ? <p className="p-5 text-sm text-muted-foreground">{t("copyAdmin.detail.noPositions")}</p> : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>{t("copyAdmin.cols.coin")}</TableHead>
                    <TableHead className="text-right">{t("copyAdmin.cols.size")}</TableHead>
                    <TableHead className="hidden text-right sm:table-cell">{t("copyAdmin.detail.entry")}</TableHead>
                    <TableHead className="text-right">{t("copyAdmin.detail.notional")}</TableHead>
                    <TableHead className="text-right">{t("copyAdmin.detail.unrealized")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {s.positions.map((p) => (
                    <TableRow key={p.coin}>
                      <TableCell className="font-semibold">{coinLabel(p.coin)} <span className={p.size > 0 ? "text-positive" : "text-negative"}>{t(p.size > 0 ? "common.long" : "common.short")}</span></TableCell>
                      <TableCell className="text-right">{format.num(Math.abs(p.size), 5)}</TableCell>
                      <TableCell className="hidden text-right sm:table-cell">{format.price(p.entryPx)}</TableCell>
                      <TableCell className="text-right">{p.notionalUsd === null ? "—" : format.usd(p.notionalUsd, { digits: 2 })}</TableCell>
                      <TableCell className={`text-right ${signClass(p.unrealizedPnl)}`}>{p.unrealizedPnl === null ? "—" : format.usd(p.unrealizedPnl, { digits: 2, sign: true })}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Panel>
        </section>

        <section>
          <SectionHeader title={t("copyAdmin.detail.versions")} />
          <Panel className="overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t("copyAdmin.detail.versionCol")}</TableHead>
                  <TableHead>{t("copyAdmin.detail.direction")}</TableHead>
                  <TableHead>{t("copyAdmin.detail.sizing")}</TableHead>
                  <TableHead className="hidden text-right sm:table-cell">{t("copyAdmin.detail.maxExposure")}</TableHead>
                  <TableHead className="hidden text-right sm:table-cell">{t("copyAdmin.detail.maxLeverage")}</TableHead>
                  <TableHead className="text-right">{t("copyAdmin.cols.time")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.versions.map((v) => (
                  <TableRow key={v.version}>
                    <TableCell className="font-semibold">v{v.version}</TableCell>
                    <TableCell>{t(`copyAdmin.detail.directions.${v.settings.direction}`)}</TableCell>
                    <TableCell>{t(`copyAdmin.detail.sizings.${v.settings.sizingMode}`)}{v.settings.perTradeUsd === null ? "" : ` · ${format.usd(v.settings.perTradeUsd, { digits: 2 })}`}</TableCell>
                    <TableCell className="hidden text-right sm:table-cell">{v.settings.maxTotalExposureUsd === null ? t("copyAdmin.detail.default") : format.usd(v.settings.maxTotalExposureUsd, { digits: 2 })}</TableCell>
                    <TableCell className="hidden text-right sm:table-cell">{v.settings.maxLeverage === null ? t("copyAdmin.detail.default") : `${v.settings.maxLeverage}×`}</TableCell>
                    <TableCell className="whitespace-nowrap text-right text-muted-foreground">{format.dateTime(v.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Panel>
        </section>

        <section>
          <SectionHeader title={t("copyAdmin.detail.orders", { count: d.orders.length })} />
          <Panel className="overflow-hidden">
            {d.orders.length === 0 ? <p className="p-5 text-sm text-muted-foreground">{t("copyAdmin.recent.empty")}</p>
              : <OrdersTable items={d.orders.map((o) => ({ ...o, userEmail: s.userEmail }))} showUser={false} />}
          </Panel>
        </section>

        <section>
          <SectionHeader title={t("copyAdmin.detail.ledger")} />
          <Panel className="overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t("copyAdmin.cols.time")}</TableHead>
                  <TableHead>{t("copyAdmin.detail.kind")}</TableHead>
                  <TableHead>{t("copyAdmin.cols.coin")}</TableHead>
                  <TableHead className="text-right">{t("copyAdmin.detail.amount")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.ledger.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{format.dateTime(l.createdAt)}</TableCell>
                    <TableCell>{l.kind}</TableCell>
                    <TableCell>{l.coin ? coinLabel(l.coin) : "—"}</TableCell>
                    <TableCell className={`text-right ${signClass(l.amount)}`}>{format.usd(l.amount, { digits: 4, sign: true })}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Panel>
        </section>
      </>
    );
  }
  return (
    <div className="flex flex-col gap-5">
      <CopyAdminNav />
      <Link href="/admin/copy/strategies" className="inline-flex w-fit items-center gap-1.5 text-sm font-semibold text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" />
        {t("copyAdmin.detail.back")}
      </Link>
      {body}
    </div>
  );
}
