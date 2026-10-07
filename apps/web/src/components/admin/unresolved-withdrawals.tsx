"use client";

import { DataList } from "@/components/ui/data-list";


import { useSaveToast } from "@/lib/use-action-toast";
import { useState } from "react";

import { Input } from "@/components/ui/input";
import { AdminCard } from "./ui";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/dialog";
import { useI18n } from "@/i18n/provider";
import { apiErrorCode } from "@/lib/api";
import { usePermission } from "@/lib/auth";
import { useResolveWithdrawal, useUnresolvedWithdrawals } from "@/lib/admin-withdrawals";
import { truncateAddress } from "@/lib/format";

/**
 * Main-wallet withdrawals whose outcome is unknown (the exchange's answer
 * was lost): while one is unresolved its address cannot withdraw or fund a
 * copy. An admin resolves it once Hyperliquid's nonce window has passed;
 * the api reads the ledger and marks it executed or not executed (audited).
 * Shown only when there is one.
 */
export function UnresolvedWithdrawals() {
  const { t, format } = useI18n();
  const canRead = usePermission("users.read");
  const canResolve = usePermission("users.manage");
  const list = useUnresolvedWithdrawals(canRead);
  const saved = useSaveToast();
  const resolve = useResolveWithdrawal();
  const [target, setTarget] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [outcome, setOutcome] = useState<string | null>(null);
  const items = list.data?.items ?? [];
  if (!items.length && !outcome) return null;
  // "Now" is when the list was read (refreshed every minute): pure render.
  const now = list.dataUpdatedAt;
  const close = () => { if (!resolve.isPending) { setTarget(null); setReason(""); resolve.reset(); } };
  return (
    <>
      <AdminCard aria-labelledby="withdrawals-in-doubt" title={<span id="withdrawals-in-doubt">{t("admin.withdrawals.title")}</span>} className="shadow-[0_0_0_2px_var(--warning)]">
        <p className="type-caption">{t("admin.withdrawals.hint")}</p>
        {outcome ? <p role="status" className="text-sm font-bold text-positive">{outcome}</p> : null}
        <DataList className="">
          {items.map((item) => {
            const open = new Date(item.resolvableAt).getTime() > now;
            return (
              <li key={item.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5 text-sm font-bold">
                <span className="font-extrabold">{item.email ?? `#${item.userId}`}</span>
                <span className="num">{format.usd(Number(item.amount), { digits: 2 })}</span>
                <span className="num text-muted-foreground" title={item.destination}>→ {truncateAddress(item.destination)}</span>
                <span className="text-muted-foreground">{t("admin.withdrawals.signed")} {format.dateTime(item.createdAt)}</span>
                <span className="text-muted-foreground">{t("admin.withdrawals.resolvable")} {format.dateTime(item.resolvableAt)}</span>
                {canResolve ? (
                  <Button size="sm" variant="secondary" className="ml-auto" disabled={open} title={open ? t("admin.withdrawals.windowOpen") : undefined} onClick={() => { setOutcome(null); setTarget(item.id); }}>
                    {open ? t("admin.withdrawals.windowOpen") : t("admin.withdrawals.resolve")}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </DataList>
      </AdminCard>
      <Modal open={target !== null} onOpenChange={(next) => { if (!next) close(); }} title={t("admin.withdrawals.resolve")}>
        <form className="flex flex-col gap-3" onSubmit={(event) => {
          event.preventDefault();
          if (!target || reason.trim().length < 3) return;
          resolve.mutate({ id: target, reason: reason.trim() }, saved({ onSuccess: (data) => {
            setOutcome(t(data.status === "accepted" ? "admin.withdrawals.accepted" : "admin.withdrawals.notExecuted"));
            setTarget(null); setReason("");
          } }));
        }}>
          <label className="text-sm font-bold" htmlFor="withdrawal-reason">{t("admin.withdrawals.reason")}</label>
          <Input id="withdrawal-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} autoComplete="off" />
          {resolve.isError ? <p role="alert" className="text-xs text-negative">{t("admin.withdrawals.failed", { reason: apiErrorCode(resolve.error) ?? resolve.error.message })}</p> : null}
          <Button type="submit" loading={resolve.isPending} disabled={!(resolve.isPending) && (resolve.isPending || reason.trim().length < 3)}>{t("admin.withdrawals.confirm")}</Button>
        </form>
      </Modal>
    </>
  );
}
