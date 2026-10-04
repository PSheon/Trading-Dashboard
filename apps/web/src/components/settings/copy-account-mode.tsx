"use client";

import { useEffect, useId, useState } from "react";
import type { CopyExecutionAccount } from "@trading-dashboard/shared/contracts";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import { useAuth } from "@/lib/auth";
import { sessionKey } from "@/lib/api";
import { canSignAccountMode, useCopyAccountModes, useCopyAccountModeActions } from "@/lib/copy-account-modes";

function useConsentClock(enabled: boolean) {
  const [now, setNow] = useState(0);
  useEffect(() => { if (!enabled) return; const refresh = () => setNow(Date.now()); const timer = window.setInterval(refresh, 1000); window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", refresh); return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); }; }, [enabled]);
  return now;
}
export function CopyAccountModeSettings({ accounts }: { accounts: readonly CopyExecutionAccount[] }) {
  const auth = useAuth();
  if (auth.status !== "signedIn" || auth.mode !== "privy") return null;
  return <AccountModeForm key={`${auth.mode}:${auth.identity}:${sessionKey()}:${auth.wallet?.address?.toLowerCase()}`} accounts={accounts}/>;
}
function AccountModeForm({ accounts }: { accounts: readonly CopyExecutionAccount[] }) {
  const { t, format } = useI18n(), auth = useAuth(), query = useCopyAccountModes();
  const [selected, setSelected] = useState(""), [reviewed, setReviewed] = useState("");
  const actions = useCopyAccountModeActions(accounts, query.data?.operations ?? [], Boolean(query.isSuccess && query.data?.available && !query.isError), selected);
  const eligible = accounts.filter(a => a.network === "testnet" && a.address && (a.state === "ready" || query.data?.operations.some(op => op.accountId === a.id)));
  const account = eligible.find(a => a.id === selected);
  const operations = query.data?.operations.filter(op => op.accountId === account?.id && op.strategyId === account.strategyId && op.network === account.network && op.accountAddress === account.address) ?? [];
  const creation = actions.recovery.data?.creations.find(item => item.accountId === selected);
  const busy = actions.prepare.isPending || actions.consent.isPending || actions.recover.isPending;
  const usable = actions.ownerReady && query.isSuccess && !query.isError && Boolean(query.data?.available) && actions.recovery.isSuccess;
  const canPrepare = usable && account?.state === "ready" && !operations.length && !creation;
  const selectionId = useId(), acknowledgmentId = useId();
  const now = Math.max(useConsentClock(Object.keys(actions.deadlines).length > 0), query.dataUpdatedAt);
  const actionError = actions.prepare.isError || actions.consent.isError || actions.recover.isError || actions.recovery.isError;
  return <section className="mt-5 border-t-2 border-dotted border-border pt-5" aria-label={t("copyAccountMode.title")}>
    <h4 className="text-sm font-bold">{t("copyAccountMode.title")}</h4>
    <p className="mt-2 text-xs leading-5 text-muted-foreground">{t("copyAccountMode.hint")}</p>
    {query.isPending ? <p role="status" className="mt-3 text-xs">{t("executionWallets.loading")}</p> : null}
    {query.isError ? <div className="mt-3"><p role="alert" className="text-xs text-warning">{t("copyAccountMode.error")}</p><Button size="sm" variant="secondary" className="mt-2" onClick={() => void query.refetch()}>{t("executionWallets.retry")}</Button></div> : null}
    {query.data && !query.data.available ? <p className="mt-3 text-xs text-muted-foreground">{t("copyAccountMode.unavailable")}</p> : null}
    <div className="mt-3 flex flex-wrap items-end gap-3"><div className="min-w-0 flex-1"><label htmlFor={selectionId} className="block text-xs font-semibold">{t("executionWallets.strategy")}</label><select id={selectionId} className="mt-1 w-full rounded-xl bg-inset px-3 py-2 text-sm" value={account ? selected : ""} disabled={busy} onChange={event => { setSelected(event.target.value); setReviewed(""); actions.prepare.reset(); actions.consent.reset(); actions.recover.reset(); }}><option value="">{t("executionWallets.selectStrategy")}</option>{eligible.map(a => <option key={a.id} value={a.id}>{t("executionWallets.copyNumber", { id: a.strategyId })} · {t("executionWallets.networks.testnet")}</option>)}</select></div><Button size="sm" disabled={!canPrepare || busy} onClick={() => { if (account && canPrepare) actions.prepare.mutate(account); }}>{t("copyAccountMode.prepare")}</Button></div>
    {account ? <dl className="mt-3 space-y-2 text-xs"><div><dt className="text-muted-foreground">{t("copyAccountMode.account")}</dt><dd className="break-all font-mono">{account.address}</dd></div><div><dt className="text-muted-foreground">{t("copyAccountMode.target")}</dt><dd>{t("copyAccountMode.targetName")} · {t("executionWallets.networks.testnet")}</dd></div><div><dt className="text-muted-foreground">{t("copyAccountMode.owner")}</dt><dd className="break-all font-mono">{auth.wallet?.address ?? t("copyAgents.waiting")}</dd></div></dl> : null}
    {actionError ? <p role="alert" className="mt-3 text-xs text-warning">{t("copyAccountMode.error")}</p> : null}
    {creation && (!creation.operationId || !operations.some(op => op.id === creation.operationId)) ? <div className="mt-3 rounded-xl bg-raised/50 p-3"><p role="status" className="text-xs leading-5">{t("copyAccountMode.localPending")}</p><Button size="sm" variant="secondary" className="mt-3" disabled={busy || query.isError || actions.recovery.isError} onClick={() => actions.recover.mutate(creation)}>{t("copyAccountMode.find")}</Button></div> : null}
    {account && query.isSuccess && !operations.length && !creation ? <p className="mt-3 text-xs text-muted-foreground">{t("copyAccountMode.empty")}</p> : null}
    {!query.isError ? operations.map(op => {
      const uncertain = Boolean(actions.recovery.data?.approvals.includes(op.id)), deadline = actions.deadlines[op.id], expired = Boolean(deadline && deadline <= now);
      const canSign = usable && account?.state === "ready" && canSignAccountMode(op) && !uncertain && !expired;
      const reviewKey = `${op.id}:${op.revision}:${account?.updatedAt}`;
      return <article key={op.id} className="mt-3 rounded-xl bg-raised/50 p-3"><dl className="space-y-2 text-xs"><div><dt className="text-muted-foreground">{t("copyAccountMode.submission")}</dt><dd role="status">{t(`copyAccountMode.submissionStates.${uncertain && op.submissionState === "prepared" ? "unknown" : op.submissionState}`)}</dd></div><div><dt className="text-muted-foreground">{t("copyAccountMode.targetObservation")}</dt><dd role="status">{t(`copyAccountMode.targetStates.${op.targetState}`)}</dd></div>{op.observedAt ? <div><dt className="text-muted-foreground">{t("copyAccountMode.observedAt")}</dt><dd>{format.dateTime(op.observedAt)}</dd></div> : null}{deadline ? <div><dt className="text-muted-foreground">{t("copyAccountMode.consentExpires")}</dt><dd>{expired ? t("copyAccountMode.expired") : format.dateTime(new Date(deadline).toISOString())}</dd></div> : null}</dl>
        {uncertain || ["unknown", "signing"].includes(op.submissionState) ? <p className="mt-2 text-xs leading-5 text-muted-foreground">{t("copyAccountMode.pendingHint")}</p> : null}
        {op.issue ? <p className="mt-2 text-xs text-warning">{t("copyAccountMode.error")}</p> : null}
        {canSign ? <label htmlFor={`${acknowledgmentId}-${op.id}`} className="mt-3 flex items-start gap-2 text-xs leading-5"><input id={`${acknowledgmentId}-${op.id}`} type="checkbox" className="mt-1 shrink-0" disabled={busy} checked={reviewed === reviewKey} onChange={event => setReviewed(event.target.checked ? reviewKey : "")}/><span>{t("copyAccountMode.review")}</span></label> : null}
        <div className="mt-3 flex flex-wrap gap-2">{canSign ? <Button size="sm" disabled={busy || reviewed !== reviewKey} onClick={() => { setReviewed(""); actions.consent.mutate({ operation: op }); }}>{t("copyAccountMode.confirm")}</Button> : null}<Button size="sm" variant="secondary" disabled={busy || actions.recovery.isError} onClick={() => { setReviewed(""); actions.consent.mutate({ operation: op, reconcileOnly: true }); }}>{t("copyAccountMode.check")}</Button></div>
      </article>;
    }) : null}
  </section>;
}
