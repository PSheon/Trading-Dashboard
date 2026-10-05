"use client";

import { useId, useState } from "react";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { useWalletModals } from "@/components/wallet/wallet-modals";
import { useI18n } from "@/i18n/provider";
import { useCopyOverview } from "@/lib/copy";
import { useCreateExecutionWallet, useExecutionWallets, useReconcileExecutionWallet, useRevokeWalletAuthorization } from "@/lib/copy-execution-wallets";
import { truncateAddress } from "@/lib/format";
import { CopyFundingSettings } from "./copy-funding";
import { CopyAgentSettings } from "./copy-agents";
import { CopyFollowerStatementSettings } from "./copy-follower-statement";
import { CopyLiveStrategySettings } from "./copy-live";
import { useActualCopyWalletPreparation, useLiveCopyOverview } from "@/lib/copy-live";
import { CopyAccountModeSettings } from "./copy-account-mode";
import { SkelBar } from "@/components/page";

/** Setup and revocation only. Preparing a wallet never starts trading. */
export function ExecutionWalletSettings() {
  const { t, format } = useI18n();
  const selectId = useId();
  const wallets = useExecutionWallets();
  const copies = useCopyOverview();
  const actual = useLiveCopyOverview();
  const create = useCreateExecutionWallet();
  const reconcile = useReconcileExecutionWallet();
  const revoke = useRevokeWalletAuthorization();
  const [selected, setSelected] = useState("");
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const { openExport } = useWalletModals();
  const data = wallets.data;
  const eligibleActual = data?.network === "testnet" ? actual.data?.strategies.filter(item => item.status === "paused" && item.pauseNewRisk && !item.reduceOnly && item.sourceNetwork === "testnet") ?? [] : [];
  const eligibleCopies = [ ...(copies.data?.strategies.filter(item => item.status !== "stopped" && item.status !== "stopping").map(item => ({ ...item, kind: "paper" as const })) ?? []), ...eligibleActual.map(item => ({ ...item, kind: "actual" as const })) ];
  const strategy = eligibleCopies.find((item) => String(item.id) === selected);
  const actualStrategy = eligibleActual.find(item => item.id === strategy?.id);
  const actualWallet = useActualCopyWalletPreparation(eligibleActual, actualStrategy?.id ?? null);
  const originalWallet = actualWallet.recovery.data?.find(item => item.strategyId === actualStrategy?.id);
  const existing = data?.accounts.some((account) => account.strategyId === strategy?.id && account.network === data.network);
  const busy = create.isPending || actualWallet.isPending || reconcile.isPending || revoke.isPending;
  const error = create.isError || actualWallet.isError || reconcile.isError || revoke.isError;

  return (
    <section className="orbit-card card-pad" aria-label={t("executionWallets.title")}>
      <h3 className="text-[0.9375rem] font-bold">{t("executionWallets.title")}</h3>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">{t("executionWallets.setupHint")}</p>
      <CopyLiveStrategySettings accounts={wallets.isError ? [] : data?.accounts ?? []} authorizations={wallets.isError ? [] : data?.authorizations ?? []}/>
      {wallets.isPending ? (
        <>
          <p role="status" className="sr-only">{t("executionWallets.loading")}</p>
          {/* The loaded card's first lines: network, a note, the copy picker. */}
          <div aria-hidden="true" className="ui-skeleton mt-3 flex flex-col gap-2">
            <SkelBar line="h-4" className="h-2.5 w-28" />
            <SkelBar line="h-4" className="h-2.5 w-44" />
            <div className="mt-2 flex items-end gap-3">
              <div className="min-w-0 flex-1">
                <SkelBar line="h-4" className="h-2.5 w-16" />
                <div className="mt-1 h-9 rounded-xl bg-inset" />
              </div>
              <div className="h-9 w-32 rounded-full bg-inset" />
            </div>
            {/* 策略測試網注資 and the other sections' heads. */}
            <SkelBar line="mt-5 h-5" className="h-3 w-32" />
            <SkelBar line="h-5" className="h-2.5 w-full max-w-md" />
            <SkelBar line="h-5" className="h-2.5 w-24" />
            <h4 className="mt-5 text-sm font-bold">{t("executionWallets.authorizations")}</h4>
            <p className="text-xs leading-5 text-muted-foreground">{t("executionWallets.revokeHint")}</p>
            <SkelBar line="mt-1 h-4" className="h-2.5 w-28" />
          </div>
        </>
      ) : null}
      {wallets.isError ? (
        <div className="mt-3 text-sm">
          <p role="alert">{t("executionWallets.loadError")}</p>
          <Button variant="secondary" size="sm" className="mt-2" onClick={() => void wallets.refetch()}>{t("executionWallets.retry")}</Button>
        </div>
      ) : null}
      {data ? (
        <>
          <p className="mt-3 text-xs font-semibold">{t("executionWallets.network")}: {t(`executionWallets.networks.${data.network}`)}</p>
          {!data.available ? <p className="mt-2 text-xs text-warning">{t("executionWallets.unavailable")}</p> : null}
          {copies.isPending && !eligibleCopies.length ? <p role="status" className="mt-3 text-xs">{t("executionWallets.loadingCopies")}</p> : copies.isError && !eligibleCopies.length ? (
            <div className="mt-3 text-xs">
              <p role="alert">{t("executionWallets.copiesError")}</p>
              <Button size="sm" variant="secondary" className="mt-2" onClick={() => void copies.refetch()}>{t("executionWallets.retry")}</Button>
            </div>
          ) : eligibleCopies.length ? (
            <div className="mt-4 flex flex-wrap items-end gap-3">
              <div className="min-w-0 flex-1">
                <label htmlFor={selectId} className="block text-xs font-semibold">{t("executionWallets.strategy")}</label>
                <Select id={selectId} value={selected} onValueChange={(value) => { setSelected(value); create.reset(); }} className="mt-1 w-full" disabled={busy} placeholder={t("executionWallets.selectStrategy")}
                  options={eligibleCopies.map((item) => ({ value: String(item.id), label: `${t("executionWallets.copyNumber", { id: item.id })} · ${truncateAddress(item.leaderAddress)}${item.kind === "actual" ? ` · ${t("copyLive.actual")}` : ""}` }))} />
              </div>
              <Button size="sm" disabled={!strategy || existing || !data.available || busy || wallets.isError || Boolean(actualStrategy && (!actual.data?.capabilities.strategyPreparation || !actualWallet.recovery.isSuccess))} onClick={() => { if (actualStrategy) actualWallet.mutate(actualStrategy); else if (strategy) create.mutate({ strategyId: strategy.id, network: data.network }); }}>
                {create.isPending || actualWallet.isPending ? t("executionWallets.creating") : existing ? t("executionWallets.prepared") : originalWallet ? t("copyLive.find") : t("executionWallets.create")}
              </Button>
            </div>
          ) : <p className="mt-3 text-xs text-muted-foreground">{t("executionWallets.noCopies")}</p>}
          {originalWallet && !existing ? <p role="status" className="mt-3 text-xs text-warning">{t("copyLive.pending")}</p> : null}
          {error ? <p role="alert" className="mt-3 text-xs text-negative">{t("executionWallets.actionError")}</p> : null}
          <div className="mt-4 space-y-3">
            {data.accounts.map((account) => (
              <article key={account.id} className="rounded-xl bg-raised/50 p-3">
                <div className="flex flex-wrap justify-between gap-2 text-xs font-semibold">
                  <h4>{t("executionWallets.copyNumber", { id: account.strategyId })} · {t(`executionWallets.networks.${account.network}`)}</h4>
                  <span>{t(`executionWallets.states.${account.state}`)}</span>
                </div>
                {account.address ? <p className="mt-2 break-all font-mono text-xs">{account.address}</p> : <p className="mt-2 text-xs text-muted-foreground">{t("executionWallets.addressPending")}</p>}
                {account.issue ? <p className="mt-2 text-xs text-warning">{t(`executionWallets.issues.${account.issue}`)}</p> : null}
                {account.state !== "ready" || !account.address ? <p className="mt-2 text-xs text-muted-foreground">{t("executionWallets.unconfirmedHint")}</p> : null}
                {account.state === "ready" ? <p className="mt-2 text-xs text-muted-foreground">{t("executionWallets.readyHint")}</p> : null}
                {account.state === "ready" && account.address ? (
                  <Button variant="secondary" size="sm" className="mt-3 mr-2" onClick={() => openExport({ address: account.address!, strategyId: account.strategyId })}>
                    {t("funds.exportCopyCta")}
                  </Button>
                ) : null}
                {account.state !== "blocked" ? (
                  <Button variant="secondary" size="sm" className="mt-3" disabled={busy} onClick={() => { create.reset(); reconcile.mutate(account.id); }}>
                    {reconcile.isPending && reconcile.variables === account.id ? t("executionWallets.checking") : t(account.state === "ready" ? "executionWallets.reverify" : "executionWallets.reconcile")}
                  </Button>
                ) : null}
              </article>
            ))}
          </div>
          <CopyFundingSettings accounts={data.accounts} />
          <CopyAccountModeSettings accounts={wallets.isError ? [] : data.accounts} />
          <CopyAgentSettings accounts={data.accounts} />
          <CopyFollowerStatementSettings accounts={data.accounts} />
          <h4 className="mt-5 text-sm font-bold">{t("executionWallets.authorizations")}</h4>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">{t("executionWallets.revokeHint")}</p>
          {!data.authorizations.length ? <p className="mt-3 text-xs text-muted-foreground">{t("executionWallets.noAuthorizations")}</p> : null}
          <div className="mt-3 space-y-3">
            {data.authorizations.map((authorization) => (
              <article key={authorization.id} className="rounded-xl bg-raised/50 p-3">
                <div className="flex flex-wrap justify-between gap-2 text-xs font-semibold">
                  <h5>{t("executionWallets.copyNumber", { id: authorization.strategyId })} · {t(`executionWallets.networks.${authorization.network}`)}</h5>
                  <span>{t(`executionWallets.statuses.${authorization.status}`)}</span>
                </div>
                <dl className="mt-2 space-y-2 text-xs">
                  <div><dt className="text-muted-foreground">{t("executionWallets.account")}</dt><dd className="break-all font-mono">{authorization.accountAddress}</dd></div>
                  <div><dt className="text-muted-foreground">{t("executionWallets.signer")}</dt><dd className="break-all font-mono">{authorization.signerAddress}</dd></div>
                  <div><dt className="text-muted-foreground">{t("executionWallets.scopes")}</dt><dd>{authorization.scopes.map((scope) => t(scope === "copy:trade" ? "executionWallets.tradeScope" : "executionWallets.reduceScope")).join(", ")}</dd></div>
                  <div><dt className="text-muted-foreground">{t("executionWallets.expires")}</dt><dd>{format.dateTime(authorization.expiresAt)}</dd></div>
                </dl>
                {confirmRevoke === authorization.id && authorization.status !== "revoked" ? (
                  <div className="mt-3">
                    <p className="text-xs text-warning">{t("executionWallets.revokeConfirmHint")}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button size="sm" variant="destructive" disabled={busy} onClick={() => revoke.mutate(authorization.id, { onSuccess: () => setConfirmRevoke(null) })}>{revoke.isPending ? t("executionWallets.revoking") : t("executionWallets.confirmRevoke")}</Button>
                      <Button size="sm" variant="secondary" disabled={busy} onClick={() => setConfirmRevoke(null)}>{t("executionWallets.cancel")}</Button>
                    </div>
                  </div>
                ) : <Button variant="secondary" size="sm" className="mt-3" disabled={busy || authorization.status === "revoked" || authorization.status === "expired"} onClick={() => { revoke.reset(); setConfirmRevoke(authorization.id); }}>{t(authorization.status === "revoked" ? "executionWallets.revoked" : "executionWallets.revoke")}</Button>}
              </article>
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}
