"use client";

import { Link } from "@/i18n/navigation";
import { useState } from "react";
import { cn } from "cn";
import type { AdminLiveAccount, AdminLiveLatency } from "@trading-dashboard/shared/contracts";

import { ErrorState, Panel, PanelSkeleton, SectionHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/i18n/provider";
import { useAdminLiveAccounts, useAdminLiveLatency, useAdminLiveOrders, useAdminLiveTransfers, useRevokeLiveGrant } from "@/lib/admin-copy";
import { usePermission } from "@/lib/auth";
import { Chip } from "./shared";
import { AdminSubTabs } from "@/components/admin/admin-shell";
import { COPY_SUB_TABS } from "./status";
import { TableSkeleton } from "@/components/ui/table-skeleton";

const short = (address: string | null) => (address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "—");
const STEPS = ["signal", "sent", "ack", "settled"] as const;
const ORDER_VIEWS = ["open", "unknown", "all"] as const;

/**
 * Testnet copies for the admin (B16, B18): copy latency P50/P95, every
 * execution wallet with its agent and grant (revoke needs execution.pause),
 * wallet transfers, and orders whose exchange outcome is open or unknown.
 */
export function AdminCopyLive() {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-5">
      <AdminSubTabs tab="copy" labels={COPY_SUB_TABS} />
      <div>
        <h2 className="type-h2">{t("copyAdmin.live.title")}</h2>
        <p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted-foreground">{t("copyAdmin.live.hint")}</p>
      </div>
      <Latency />
      <Accounts />
      <Orders />
      <Transfers />
    </div>
  );
}

function Latency() {
  const { t, format } = useI18n();
  const [window, setWindow] = useState<"24h" | "7d">("24h");
  const latency = useAdminLiveLatency(window);
  const d: AdminLiveLatency | undefined = latency.data;
  const ms = (value: number | null) => (value === null ? "—" : `${format.num(value, 0)} ms`);
  return (
    <Panel className="card-pad" aria-labelledby="copy-live-latency-title" data-testid="copy-live-latency">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h3 id="copy-live-latency-title" className="type-h2">{t("copyAdmin.live.latency.title")}</h3>
        {d ? <Chip tone="info">{t("copyAdmin.live.latency.legs", { count: d.count })}</Chip> : null}
        <div className="ml-auto flex gap-1" role="group">
          {(["24h", "7d"] as const).map((w) => (
            <Button key={w} size="sm" variant={w === window ? "default" : "secondary"} aria-pressed={w === window} onClick={() => setWindow(w)}>
              {t(w === "24h" ? "copyAdmin.live.latency.window24h" : "copyAdmin.live.latency.window7d")}
            </Button>
          ))}
        </div>
      </div>
      <p className="mb-3 text-sm text-muted-foreground">{t("copyAdmin.live.latency.hint")}</p>
      {latency.isError && !d ? <ErrorState message={latency.error.message} onRetry={() => latency.refetch()} />
        : !d ? <PanelSkeleton tiles={4} />
        : d.count === 0 ? <p className="text-sm text-muted-foreground">{t("copyAdmin.live.latency.none")}</p>
        : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t("copyAdmin.live.latency.step")}</TableHead>
                <TableHead className="text-right">P50</TableHead>
                <TableHead className="text-right">P95</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {STEPS.map((step) => (
                <TableRow key={step}>
                  <TableCell>{t(`copyAdmin.live.latency.${step}`)}</TableCell>
                  <TableCell className="num text-right font-semibold">{ms(d[step].p50)}</TableCell>
                  <TableCell className="num text-right font-semibold">{ms(d[step].p95)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
    </Panel>
  );
}

function Accounts() {
  const { t, format } = useI18n();
  const accounts = useAdminLiveAccounts();
  const canRevoke = usePermission("execution.pause");
  const [target, setTarget] = useState<AdminLiveAccount | null>(null);
  const items = accounts.data?.items ?? [];
  return (
    <section aria-labelledby="copy-live-accounts-title">
      <SectionHeader title={<span id="copy-live-accounts-title">{t("copyAdmin.live.accounts.title")}</span>} />
      <Panel className="overflow-x-auto">
        {accounts.isError && !accounts.data ? <ErrorState message={accounts.error.message} onRetry={() => accounts.refetch()} />
          : !accounts.data ? <div className="p-3"><TableSkeleton rows={3} columns={[{}, {}, {}, { right: true }, { right: true }]} /></div>
          : items.length === 0 ? <p className="p-5 text-sm text-muted-foreground">{t("copyAdmin.live.accounts.empty")}</p>
          : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t("copyAdmin.live.accounts.user")}</TableHead>
                  <TableHead>{t("copyAdmin.live.accounts.strategy")}</TableHead>
                  <TableHead>{t("copyAdmin.live.accounts.wallet")}</TableHead>
                  <TableHead>{t("copyAdmin.live.accounts.agent")}</TableHead>
                  <TableHead>{t("copyAdmin.live.accounts.grant")}</TableHead>
                  <TableHead>{t("copyAdmin.live.accounts.mandate")}</TableHead>
                  <TableHead>{t("copyAdmin.live.accounts.stop")}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((a) => (
                  <TableRow key={a.accountId}>
                    <TableCell className="max-w-[12rem] truncate">{a.userEmail ?? `#${a.userId}`}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      <Link href={`/admin/copy/strategies/${a.strategyId}`} className="underline decoration-border underline-offset-4">#{a.strategyId}</Link>
                      <span className="block text-xs text-muted-foreground">{short(a.leaderAddress)} · {t(a.sourceNetwork === "mainnet" ? "copyAdmin.live.accounts.mainnet" : "copyAdmin.live.accounts.testnet")}</span>
                    </TableCell>
                    <TableCell className="num whitespace-nowrap">{short(a.accountAddress)}<span className="block text-xs text-muted-foreground">{a.accountState} · {a.strategyStatus}</span></TableCell>
                    <TableCell className="num whitespace-nowrap">{a.agent ? <>{short(a.agent.agentAddress)}<span className="block text-xs text-muted-foreground">{a.agent.state}</span></> : "—"}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {a.grant ? (
                        <>
                          <span className="num">v{a.grant.version}</span> <span className="text-xs text-muted-foreground">{a.grant.scopes.join(", ")}</span>
                          <span className={cn("block text-xs", a.grant.revokedAt ? "text-negative" : a.grant.revokeRequestedAt ? "text-warning" : "text-muted-foreground")}>
                            {a.grant.revokedAt ? t("copyAdmin.live.accounts.revoked", { date: format.dateTime(a.grant.revokedAt) })
                              : a.grant.revokeRequestedAt ? t("copyAdmin.live.accounts.revokePending", { date: format.dateTime(a.grant.revokeRequestedAt) })
                              : t("copyAdmin.live.accounts.expires", { date: format.dateTime(a.grant.expiresAt) })}
                          </span>
                        </>
                      ) : "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{a.mandate ? `${a.mandate.state} · r${a.mandate.revision}` : "—"}</TableCell>
                    <TableCell className="whitespace-nowrap">{a.stop ? <>{a.stop.state}{a.stop.issue ? <span className="block text-xs text-warning">{a.stop.issue}</span> : null}</> : "—"}</TableCell>
                    <TableCell className="text-right">
                      {canRevoke && a.grant && !a.grant.revokedAt ? (
                        <Button size="sm" variant="secondary" onClick={() => setTarget(a)}>
                          {a.grant.revokeRequestedAt ? t("copyAdmin.live.accounts.revokeNow") : t("copyAdmin.live.accounts.revoke")}
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
      </Panel>
      <Modal open={target !== null} onOpenChange={(open) => { if (!open) setTarget(null); }} title={t(target?.grant?.revokeRequestedAt ? "copyAdmin.live.revoke.forceTitle" : "copyAdmin.live.revoke.title")}>
        {target?.grant ? <RevokeForm key={target.grant.id} grant={target.grant} force={Boolean(target.grant.revokeRequestedAt)} onClose={() => setTarget(null)} /> : null}
      </Modal>
    </section>
  );
}

/** The revoke, or (`force`, while a requested revoke waits for the copy's
 * stop) the immediate revoke, which needs an explicit confirmation that
 * positions may remain open with nobody to close them. */
function RevokeForm({ grant, force, onClose }: { grant: NonNullable<AdminLiveAccount["grant"]>; force: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const revoke = useRevokeLiveGrant();
  const [reason, setReason] = useState("");
  const [understood, setUnderstood] = useState(false);
  const ok = reason.trim().length >= 3 && (!force || understood);
  return (
    <form className="flex flex-col gap-4" onSubmit={(event) => {
      event.preventDefault();
      if (ok && !revoke.isPending) revoke.mutate({ id: grant.id, reason: reason.trim(), force }, { onSuccess: onClose });
    }}>
      <p className="text-sm leading-relaxed text-muted-foreground">{t(force ? "copyAdmin.live.revoke.forceHelp" : "copyAdmin.live.revoke.help")}</p>
      <p className="num rounded-xl bg-raised p-3 text-xs font-semibold">{t("copyAdmin.live.revoke.target", { id: grant.id, version: grant.version })}</p>
      <div className="grid gap-2">
        <Label htmlFor="copy-live-revoke-reason">{t("copyAdmin.live.revoke.reason")}</Label>
        <Textarea id="copy-live-revoke-reason" required minLength={3} maxLength={500} rows={3} value={reason} onChange={(event) => setReason(event.target.value)}
          placeholder={t("copyAdmin.live.revoke.reasonHint")} className="font-sans" />
      </div>
      {force ? (
        <label className="flex items-start gap-2.5 text-sm">
          <input type="checkbox" checked={understood} onChange={(event) => setUnderstood(event.target.checked)} className="mt-0.5 size-4 shrink-0 accent-[var(--color-negative)]" />
          <span>{t("copyAdmin.live.revoke.forceConfirm")}</span>
        </label>
      ) : null}
      {revoke.isError ? <p role="alert" className="rounded-xl bg-negative-soft px-3.5 py-2.5 text-sm text-negative">{t("copyAdmin.live.revoke.failed", { message: revoke.error.message })}</p> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onClose}>{t("copyAdmin.live.revoke.cancel")}</Button>
        <Button type="submit" disabled={!ok || revoke.isPending}>{revoke.isPending ? t("copyAdmin.live.revoke.sending") : t(force ? "copyAdmin.live.revoke.forceSubmit" : "copyAdmin.live.revoke.confirm")}</Button>
      </div>
    </form>
  );
}

function Orders() {
  const { t, format } = useI18n();
  const [view, setView] = useState<(typeof ORDER_VIEWS)[number]>("open");
  const orders = useAdminLiveOrders(view);
  const items = orders.data?.items ?? [];
  return (
    <section aria-labelledby="copy-live-orders-title">
      <SectionHeader title={<span id="copy-live-orders-title">{t("copyAdmin.live.orders.title")}</span>}
        action={
          <div className="flex gap-1" role="group">
            {ORDER_VIEWS.map((v) => (
              <Button key={v} size="sm" variant={v === view ? "default" : "secondary"} aria-pressed={v === view} onClick={() => setView(v)}>{t(`copyAdmin.live.orders.${v}`)}</Button>
            ))}
          </div>
        } />
      {view === "unknown" ? <p className="mb-2 max-w-3xl text-sm text-muted-foreground">{t("copyAdmin.live.orders.unknownHint")}</p> : null}
      <Panel className="overflow-x-auto">
        {orders.isError && !orders.data ? <ErrorState message={orders.error.message} onRetry={() => orders.refetch()} />
          : !orders.data ? <div className="p-3"><TableSkeleton rows={3} columns={[{}, {}, {}, { right: true }, { right: true }]} /></div>
          : items.length === 0 ? <p className="p-5 text-sm text-muted-foreground">{t("copyAdmin.live.orders.empty")}</p>
          : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t("copyAdmin.live.transfers.time")}</TableHead>
                  <TableHead>{t("copyAdmin.live.accounts.strategy")}</TableHead>
                  <TableHead>{t("copyAdmin.live.orders.purpose")}</TableHead>
                  <TableHead>{t("copyAdmin.live.orders.coin")}</TableHead>
                  <TableHead>{t("copyAdmin.live.orders.side")}</TableHead>
                  <TableHead className="text-right">{t("copyAdmin.live.orders.size")}</TableHead>
                  <TableHead className="text-right">{t("copyAdmin.live.orders.price")}</TableHead>
                  <TableHead>{t("copyAdmin.live.orders.state")}</TableHead>
                  <TableHead>{t("copyAdmin.live.orders.error")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((o) => (
                  <TableRow key={o.key}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{format.dateTime(o.updatedAt)}</TableCell>
                    <TableCell className="whitespace-nowrap">#{o.strategyId}<span className="num block text-xs text-muted-foreground">{short(o.accountAddress)}</span></TableCell>
                    <TableCell>{t(`copyAdmin.live.orders.purposes.${o.purpose}`)}{o.leg ? <span className="block text-xs text-muted-foreground">{o.leg.leg} · {o.leg.state}</span> : null}</TableCell>
                    <TableCell className="font-semibold">{o.coin ?? "—"}</TableCell>
                    <TableCell className={o.side === "B" ? "text-positive" : "text-negative"}>{t(o.side === "B" ? "copyAdmin.live.orders.buy" : "copyAdmin.live.orders.sell")}{o.reduceOnly ? " · RO" : ""}</TableCell>
                    <TableCell className="num text-right">{o.size}</TableCell>
                    <TableCell className="num text-right">{o.limitPrice}</TableCell>
                    <TableCell><Chip tone={o.state === "unknown" || o.state === "submitting" ? "warn" : o.state === "rejected" ? "bad" : "neutral"}>{o.state}</Chip></TableCell>
                    <TableCell className="text-xs text-muted-foreground">{o.errorCode ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
      </Panel>
    </section>
  );
}

function Transfers() {
  const { t, format } = useI18n();
  const transfers = useAdminLiveTransfers();
  const items = transfers.data?.items ?? [];
  return (
    <section aria-labelledby="copy-live-transfers-title">
      <SectionHeader title={<span id="copy-live-transfers-title">{t("copyAdmin.live.transfers.title")}</span>} />
      <Panel className="overflow-x-auto">
        {transfers.isError && !transfers.data ? <ErrorState message={transfers.error.message} onRetry={() => transfers.refetch()} />
          : !transfers.data ? <div className="p-3"><TableSkeleton rows={3} columns={[{}, {}, {}, { right: true }, { right: true }]} /></div>
          : items.length === 0 ? <p className="p-5 text-sm text-muted-foreground">{t("copyAdmin.live.transfers.empty")}</p>
          : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t("copyAdmin.live.transfers.time")}</TableHead>
                  <TableHead>{t("copyAdmin.live.accounts.strategy")}</TableHead>
                  <TableHead>{t("copyAdmin.live.transfers.status")}</TableHead>
                  <TableHead className="text-right">{t("copyAdmin.live.transfers.amount")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((x) => (
                  <TableRow key={x.id}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{format.dateTime(x.createdAt)}</TableCell>
                    <TableCell className="whitespace-nowrap">#{x.strategyId}<span className="num block text-xs text-muted-foreground">{short(x.source)} → {short(x.destination)}</span></TableCell>
                    <TableCell>{t(`copyAdmin.live.transfers.${x.direction}`)} · <Chip tone={x.status === "credited" ? "good" : x.status === "rejected" ? "bad" : "neutral"}>{x.status}</Chip></TableCell>
                    <TableCell className="num text-right font-semibold">{x.amount} USDC</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
      </Panel>
    </section>
  );
}
