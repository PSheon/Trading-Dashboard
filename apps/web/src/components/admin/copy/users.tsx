"use client";

import { useState } from "react";
import type { CopyControlCommand } from "@trading-dashboard/shared/contracts";

import { ErrorState, Panel, PanelSkeleton } from "@/components/page";
import { useI18n } from "@/i18n/provider";
import { useAdminCopyExposure } from "@/lib/admin-copy";
import { coinLabel } from "@/lib/format";
import { ControlDialog, type ControlRequest } from "./control-dialog";
import { ControlButtons, ControlState, CopyAdminNav } from "./shared";

/** Per-user exposure across their live copies, with that user's own stop
 * state and commands. A user-level stop is separate from the platform's
 * and from each copy's own pause: resuming here lifts this level only. */
export function AdminCopyUsers() {
  const { t, format } = useI18n();
  const exposure = useAdminCopyExposure();
  const [picked, setPicked] = useState<{ userId: number; command: CopyControlCommand } | null>(null);
  const items = exposure.data?.items;
  const target = picked ? items?.find((u) => u.userId === picked.userId) : undefined;
  const request: ControlRequest | null = picked && target
    ? { target: { scope: "user", userId: target.userId }, targetLabel: target.userEmail ?? `#${target.userId}`, command: picked.command,
        revision: target.control.revision, impact: { strategies: target.strategies, exposureUsd: target.exposureUsd } }
    : null;

  return (
    <div className="flex flex-col gap-4">
      <CopyAdminNav />
      <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">{t("copyAdmin.users.hint")}</p>
      {exposure.isError && !items ? <Panel><ErrorState message={exposure.error.message} onRetry={() => exposure.refetch()} /></Panel>
        : !items ? <PanelSkeleton rows={4} />
        : items.length === 0 ? <Panel className="p-5 text-sm text-muted-foreground">{t("copyAdmin.users.empty")}</Panel>
        : (
          <div className="grid gap-3 xl:grid-cols-2">
            {items.map((u) => (
              <Panel key={u.userId} className="flex min-w-0 flex-col gap-4 p-5" aria-label={u.userEmail ?? `#${u.userId}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="min-w-0 truncate text-[0.9375rem] font-bold">{u.userEmail ?? `#${u.userId}`}</h2>
                  <span className="num text-xs text-subtle-foreground">#{u.userId}</span>
                  <span className="ml-auto flex items-center gap-2">
                    <ControlState state={u.control} />
                    <span className="num text-xs text-subtle-foreground">r{u.control.revision}</span>
                  </span>
                </div>
                <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                  <Fact label={t("copyAdmin.kpi.strategies")} value={format.num(u.strategies, 0)} />
                  <Fact label={t("copyAdmin.cols.allocated")} value={format.usd(u.allocated, { digits: 2 })} />
                  <Fact label={t("copyAdmin.cols.equity")} value={u.equity === null ? "—" : format.usd(u.equity, { digits: 2 })} />
                  <Fact label={t("copyAdmin.kpi.exposure")} value={u.exposureUsd === null ? "—" : format.usd(u.exposureUsd, { digits: 2 })} />
                </dl>
                {u.coins.length > 0 ? (
                  <ul className="flex flex-wrap gap-1.5 text-xs">
                    {u.coins.map((c) => (
                      <li key={c.coin} className="num rounded-full bg-raised px-2.5 py-1">
                        <span className="font-semibold">{coinLabel(c.coin)}</span>{" "}
                        <span className={c.netUsd >= 0 ? "text-positive" : "text-negative"}>{format.usd(c.netUsd, { compact: true, sign: true })}</span>
                        <span className="text-subtle-foreground"> · {t("copyAdmin.users.longShort", { long: format.usd(c.longUsd, { compact: true }), short: format.usd(c.shortUsd, { compact: true }) })}</span>
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-xs text-subtle-foreground">{t("copyAdmin.detail.noPositions")}</p>}
                <ControlButtons size="xs" state={u.control} onPick={(command) => setPicked({ userId: u.userId, command })} />
              </Panel>
            ))}
          </div>
        )}
      {exposure.data?.pricedAt ? <p className="num text-right text-[11px] text-subtle-foreground">{t("copyAdmin.users.pricedAt", { time: format.dateTime(exposure.data.pricedAt) })}</p> : null}
      <ControlDialog request={request} onClose={() => setPicked(null)} />
    </div>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="num mt-1 truncate font-semibold">{value}</dd>
    </div>
  );
}
