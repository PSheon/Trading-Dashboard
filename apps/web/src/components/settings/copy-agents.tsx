"use client";

import { useEffect, useId, useState } from "react";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import { useAuth } from "@/lib/auth";
import { sessionKey } from "@/lib/api";
import { useCopyAgents, useCopyAgentActions } from "@/lib/copy-agents";
import type { CopyAgentSetup, CopyExecutionAccount } from "@trading-dashboard/shared/contracts";

const terminal = (op: CopyAgentSetup) => ["blocked", "revoked", "expired"].includes(op.state);

/** Expiry must advance independently of GET success, including after a paused tab resumes. */
function useAgentClock(enabled: boolean) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const refresh = () => setNow(Date.now());
    const timer = window.setInterval(refresh, 1000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [enabled]);
  return now;
}

export function CopyAgentSettings({ accounts }: { accounts: CopyExecutionAccount[] }) {
  const { identity, mode, status, wallet } = useAuth();
  if (mode !== "privy" || status !== "signedIn") return null;
  return <AgentForm key={`${mode}:${identity}:${sessionKey()}:${wallet?.address?.toLowerCase()}`} accounts={accounts} />;
}
function AgentForm({ accounts }: { accounts: CopyExecutionAccount[] }) {
  const { t, format } = useI18n(), auth = useAuth(), query = useCopyAgents();
  const data = query.data, setups = data?.setups ?? [];
  const now = Math.max(useAgentClock(setups.length > 0), query.dataUpdatedAt);
  const { prepare, approve, reconcile, recovery, ownerReady } = useCopyAgentActions(accounts, setups);
  const selectId = useId(), daysId = useId(), acknowledgmentId = useId();
  const [accountId, setAccountId] = useState(""), [days, setDays] = useState("7"), [reviewed, setReviewed] = useState<string[]>([]);
  const journal = recovery.data;
  const eligible = accounts.filter((a) => a.state === "ready" && a.network === "testnet" && a.address && !setups.some((op) => op.accountId === a.id && !terminal(op)));
  const account = eligible.find((a) => a.id === accountId);
  const original = setups.find((op) => op.accountId === accountId);
  const savedCreation = journal?.creations.find((item) => item.accountId === accountId);
  const unresolvedCreation = Boolean(savedCreation && (!savedCreation.operationId || savedCreation.operationId !== original?.id));
  const pendingCreations = journal?.creations.filter((item) => item.operationId ? !setups.some((op) => op.id === item.operationId) : !setups.some((op) => op.accountId === item.accountId && !terminal(op))) ?? [];
  const busy = prepare.isPending || approve.isPending || reconcile.isPending;
  const validDays = Number.isInteger(Number(days)) && Number(days) >= 1 && Number(days) <= 30;
  const canPrepare = ownerReady && data?.available && data.network === "testnet" && recovery.isSuccess && !query.isError;
  const canRecover = auth.status === "signedIn" && auth.mode === "privy" && !query.isError;
  const actionError = prepare.isError || approve.isError || reconcile.isError || recovery.isError;
  return <section className="mt-5 border-t-2 border-dotted border-border pt-5" aria-label={t("copyAgents.title")}>
    <h4 className="text-sm font-bold">{t("copyAgents.title")}</h4>
    <p className="mt-2 text-xs leading-5 text-muted-foreground">{t("copyAgents.hint")}</p>
    {query.isPending && auth.status === "signedIn" ? <p role="status" className="mt-3 text-xs">{t("executionWallets.loading")}</p> : null}
    {query.isError ? <div className="mt-3"><p role="alert" className="text-xs text-warning">{t("copyAgents.error")}</p><Button size="sm" variant="secondary" className="mt-2" onClick={() => void query.refetch()}>{t("executionWallets.retry")}</Button></div> : null}
    {data && (!data.available || data.network !== "testnet") ? <p className="mt-3 text-xs text-muted-foreground">{t("copyAgents.unavailable")}</p> : null}
    {canPrepare && eligible.length ? <form className="mt-3 flex flex-wrap items-end gap-3" onSubmit={(event) => {
      event.preventDefault(); if (!account || !validDays || busy || unresolvedCreation) return;
      prepare.mutate({ account, validForDays: Number(days), replacement: original && terminal(original) ? original : undefined });
    }}>
      <div className="min-w-0 flex-1"><label htmlFor={selectId} className="block text-xs font-semibold">{t("executionWallets.strategy")}</label>
        <Select id={selectId} className="mt-1 w-full" value={accountId} disabled={busy} placeholder={t("executionWallets.selectStrategy")} onValueChange={(value) => { setAccountId(value); setDays(String(journal?.creations.find((item) => item.accountId === value)?.validForDays ?? 7)); prepare.reset(); }} options={eligible.map((a) => ({ value: a.id, label: t("executionWallets.copyNumber", { id: a.strategyId }) }))} /></div>
      <div><label htmlFor={daysId} className="block text-xs font-semibold">{t("copyAgents.days")}</label><input id={daysId} type="number" min="1" max="30" step="1" className="mt-1 w-28 rounded-xl bg-inset px-3 py-2 text-sm" value={days} disabled={busy || unresolvedCreation} onChange={(event) => setDays(event.target.value)} /></div>
      <Button type="submit" size="sm" disabled={!account || !validDays || busy || unresolvedCreation}>{original && terminal(original) ? t("copyAgents.replacement") : t("copyAgents.prepare")}</Button>
    </form> : null}
    {actionError ? <p role="alert" className="mt-3 text-xs text-warning">{t("copyAgents.error")}</p> : null}
    {!setups.length && data ? <p className="mt-3 text-xs text-muted-foreground">{t("copyAgents.empty")}</p> : null}
    {pendingCreations.map((item) => {
      const ownerAccount = accounts.find((a) => a.id === item.accountId && a.strategyId === item.strategyId && a.address === item.address && a.network === item.network);
      return <article key={item.key} className="mt-3 rounded-xl bg-raised/50 p-3"><h5 className="text-xs font-semibold">{t("executionWallets.copyNumber", { id: item.strategyId })} · {t("executionWallets.networks.testnet")}</h5><p className="mt-2 text-xs text-muted-foreground" role="status">{t("copyAgents.localPending")}</p><p className="mt-2 break-all font-mono text-xs">{item.address}</p><Button size="sm" variant="secondary" className="mt-3" disabled={busy || !ownerReady || !ownerAccount || query.isError} onClick={() => { if (ownerAccount) prepare.mutate({ account: ownerAccount, validForDays: item.validForDays }); }}>{t("copyAgents.reconcile")}</Button></article>;
    })}
    <div className="mt-3 space-y-3">{setups.map((op) => {
      const uncertain = Boolean(journal?.approvals.includes(op.id));
      const expired = Date.parse(op.expiresAt) <= now;
      const ownerAccount = accounts.find((a) => a.id === op.accountId && a.strategyId === op.strategyId && a.network === op.network && a.address === op.accountAddress && a.state === "ready");
      const canApprove = op.state === "ready" && op.network === "testnet" && !uncertain && !expired && canPrepare && Boolean(ownerAccount);
      const status = expired && !terminal(op) ? "expired" : uncertain && op.state === "ready" ? "approval_unknown" : op.state;
      return <article key={op.id} className="rounded-xl bg-raised/50 p-3">
        <div className="flex flex-wrap justify-between gap-2 text-xs font-semibold"><h5>{t("executionWallets.copyNumber", { id: op.strategyId })} · {t(`executionWallets.networks.${op.network}`)}</h5><span role="status">{t(`copyAgents.states.${status}`)}</span></div>
        <dl className="mt-2 space-y-2 text-xs"><div><dt className="text-muted-foreground">{t("copyAgents.account")}</dt><dd className="break-all font-mono">{op.accountAddress}</dd></div><div><dt className="text-muted-foreground">{t("copyAgents.agent")}</dt><dd className="break-all font-mono">{op.agentAddress ?? t("copyAgents.waiting")}</dd></div><div><dt className="text-muted-foreground">{t("copyAgents.expires")}</dt><dd>{format.dateTime(op.expiresAt)}</dd></div>{canApprove ? <div><dt className="text-muted-foreground">{t("copyAgents.owner")}</dt><dd className="break-all font-mono">{auth.wallet?.address}</dd></div> : null}</dl>
        {uncertain || ["policy_unknown", "wallet_unknown", "approval_unknown", "approval_signing"].includes(op.state) ? <p className="mt-2 text-xs leading-5 text-muted-foreground">{t("copyAgents.pendingHint")}</p> : null}
        {op.issue ? <p className="mt-2 text-xs text-warning">{t("copyAgents.error")}</p> : null}
        {canApprove ? <label htmlFor={`${acknowledgmentId}-${op.id}`} className="mt-3 flex items-start gap-2 text-xs leading-5"><input id={`${acknowledgmentId}-${op.id}`} type="checkbox" className="mt-1 shrink-0" checked={reviewed.includes(op.id)} disabled={busy} onChange={(event) => setReviewed(event.target.checked ? [...reviewed, op.id] : reviewed.filter((id) => id !== op.id))} /><span>{t("copyAgents.acknowledge")}</span></label> : null}
        <div className="mt-3 flex flex-wrap gap-2">{canApprove ? <Button size="sm" disabled={busy || !reviewed.includes(op.id)} onClick={() => { setReviewed(reviewed.filter((id) => id !== op.id)); approve.mutate(op); }}>{approve.isPending ? t("copyAgents.signing") : t("copyAgents.confirm")}</Button> : null}<Button size="sm" variant="secondary" disabled={busy || !canRecover} onClick={() => reconcile.mutate(op)}>{t("copyAgents.reconcile")}</Button></div>
      </article>;
    })}</div>
  </section>;
}
