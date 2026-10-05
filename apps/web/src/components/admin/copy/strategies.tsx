"use client";

import Link from "next/link";

import { ErrorState, Panel, PanelSkeleton, SectionHeader } from "@/components/page";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useI18n } from "@/i18n/provider";
import { useAdminCopyStrategy } from "@/lib/admin-copy";
import type { AdminCopyStrategyView } from "@/lib/contracts";
import { coinLabel, signClass, truncateAddress } from "@/lib/format";
import { Chip, OrdersTable, StrategyStatus } from "./shared";


export function StrategyFlags({ strategy }: { strategy: AdminCopyStrategyView }) {
  const { t } = useI18n();
  return (
    <span className="inline-flex flex-wrap gap-1">
      <StrategyStatus status={strategy.status} />
      {strategy.reduceOnly ? <Chip tone="warn">{t("copyAdmin.state.reduceOnly")}</Chip> : null}
    </span>
  );
}

/** One copy: who, whom, its money, positions, every settings version, its
 * orders with reasons and the ledger (the old copy/strategies/[id] page,
 * now the 帳本 drawer of the 跟單 tab). */
export function StrategyDetailBody({ id }: { id: number }) {
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
        <section className="orbit-card card-pad">
          <div className="mb-4 flex flex-wrap items-center gap-2.5">
            <h3 className="type-h2">{t("copyAdmin.detail.title", { id: s.id })}</h3>
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
        </section>

        <section>
          <SectionHeader className="mb-1" title={t("copyAdmin.detail.positions")} />
          <div className="min-w-0">
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
          </div>
        </section>

        <section>
          <SectionHeader className="mb-1" title={t("copyAdmin.detail.versions")} />
          <div className="min-w-0">
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
          </div>
        </section>

        <section>
          <SectionHeader className="mb-1" title={t("copyAdmin.detail.orders", { count: d.orders.length })} />
          <div className="min-w-0">
            {d.orders.length === 0 ? <p className="p-5 text-sm text-muted-foreground">{t("copyAdmin.recent.empty")}</p>
              : <OrdersTable items={d.orders.map((o) => ({ ...o, userEmail: s.userEmail }))} showUser={false} />}
          </div>
        </section>

        <section>
          <SectionHeader className="mb-1" title={t("copyAdmin.detail.ledger")} />
          <div className="min-w-0">
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
          </div>
        </section>
      </>
    );
  }
  return <div className="flex flex-col gap-5">{body}</div>;
}
