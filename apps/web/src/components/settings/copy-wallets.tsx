"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useWalletModals } from "@/components/wallet/wallet-modals";
import { useLiveSetupText } from "@/components/copy/live-copy-setup-dialogs";
import { useI18n } from "@/i18n/provider";
import { useExecutionWallets, useRevokeWalletAuthorization } from "@/lib/copy-execution-wallets";
import { truncateAddress } from "@/lib/format";

/**
 * Settings' 跟單錢包 (plan §4 "Settings → /dev"): the user's own copy
 * wallets, read only, with 匯出私鑰 (Privy's own modal; the key never
 * reaches Orbie) and revoking a trading agent. Setting a copy up happens on
 * the trader page; the step-by-step forms live at /dev/copy (lab only).
 */
export function CopyWalletsList() {
  const text = useLiveSetupText(), { t, format } = useI18n();
  const wallets = useExecutionWallets(), revoke = useRevokeWalletAuthorization();
  const { openExport } = useWalletModals();
  const [confirming, setConfirming] = useState<string | null>(null);
  const data = wallets.data;
  const accounts = data?.accounts.filter(account => account.state === "ready" && account.address) ?? [];
  if (!data || (!accounts.length && !data.authorizations.length)) return null;
  return (
    <section className="orbit-card card-pad" aria-label={text.wallets}>
      <h3 className="text-[0.9375rem] font-bold">{text.wallets}</h3>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">{text.walletsHint}</p>
      {!accounts.length ? <p className="mt-3 text-xs text-muted-foreground">{text.walletsEmpty}</p> : null}
      <ul className="mt-3 divide-y-2 divide-dotted divide-border">
        {accounts.map(account => {
          const grants = data.authorizations.filter(grant => grant.accountAddress === account.address && grant.status !== "revoked" && grant.status !== "expired");
          return (
            <li key={account.id} className="flex flex-col gap-2 py-3 text-xs">
              <div className="flex flex-wrap items-center gap-2 font-semibold">
                <span>{t("executionWallets.copyNumber", { id: account.strategyId })}</span>
                <span className="rounded bg-raised px-1.5 py-0.5 text-[11px] text-muted-foreground">{t(`executionWallets.networks.${account.network}`)}</span>
                {account.automaticReturn ? <span className="rounded bg-positive/15 px-1.5 py-0.5 text-[11px] text-positive">{text.automaticReturnOn}</span> : null}
              </div>
              <p className="num break-all font-mono text-muted-foreground" title={account.address!}>{truncateAddress(account.address!)}</p>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" size="sm" onClick={() => openExport({ address: account.address!, strategyId: account.strategyId })}>{text.exportKey}</Button>
                {grants.map(grant => confirming === grant.id ? (
                  <span key={grant.id} className="flex flex-wrap items-center gap-2">
                    <span className="text-warning">{t("executionWallets.revokeConfirmHint")}</span>
                    <Button size="sm" variant="destructive" loading={revoke.isPending && revoke.variables === grant.id} disabled={!(revoke.isPending && revoke.variables === grant.id) && (revoke.isPending)} onClick={() => revoke.mutate(grant.id, { onSuccess: () => setConfirming(null) })}>{t("executionWallets.confirmRevoke")}</Button>
                    <Button size="sm" variant="secondary" disabled={revoke.isPending} onClick={() => setConfirming(null)}>{t("executionWallets.cancel")}</Button>
                  </span>
                ) : (
                  <Button key={grant.id} size="sm" variant="secondary" onClick={() => { revoke.reset(); setConfirming(grant.id); }}>
                    {text.revoke} · {format.date(grant.expiresAt)}
                  </Button>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
      {revoke.isError ? <p role="alert" className="mt-2 text-xs text-negative">{t("executionWallets.actionError")}</p> : null}
    </section>
  );
}
