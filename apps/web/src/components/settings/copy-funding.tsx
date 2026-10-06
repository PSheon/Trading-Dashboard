"use client";

import { useId, useState } from "react";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import { sessionKey } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useCopyFunding, useReserveCopyFunding, useConfirmCopyFunding, useCancelCopyFunding } from "@/lib/copy-funding";
import { copyFundingInputSchema, type CopyExecutionAccount } from "@trading-dashboard/shared/contracts";
import { CopyIconButton } from "@/components/wallet/bits";

/** Funding is explicit, testnet-only, and independent of paper collateral. */
export function CopyFundingSettings({ accounts }: { accounts: CopyExecutionAccount[] }) {
  const { t, format } = useI18n(), { wallet, identity, mode } = useAuth();
  return <FundingForm key={`${mode}:${identity}:${sessionKey()}`} accounts={accounts} walletAddress={wallet?.address?.toLowerCase()} t={t} format={format} />;
}
function FundingForm({ accounts, walletAddress, t, format }: { accounts: CopyExecutionAccount[]; walletAddress?: string; t: ReturnType<typeof useI18n>["t"]; format: ReturnType<typeof useI18n>["format"] }) {
  const selectId = useId(), amountId = useId();
  const query = useCopyFunding(), prepare = useReserveCopyFunding(), confirm = useConfirmCopyFunding(accounts, query.data?.operations ?? [], Boolean(query.data?.available && !query.isError)), cancel = useCancelCopyFunding();
  const [accountId, setAccountId] = useState(""), [amount, setAmount] = useState("10"), [key, setKey] = useState<string | null>(null);
  const data = query.data, operations = data?.operations ?? [];
  const pending = operations.some((item) => ["prepared", "unknown", "accepted"].includes(item.status));
  const eligible = accounts.filter((item) => item.network === data?.network && item.state === "ready" && item.address);
  const busy = prepare.isPending || confirm.isPending || cancel.isPending;
  const valid = copyFundingInputSchema.safeParse({ amount, idempotencyKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }).success;
  return <section className="mt-5 border-t-2 border-dotted border-border pt-5" aria-label={t("copyFunding.title")}>
    <h4 className="text-sm font-bold">{t("copyFunding.title")}</h4>
    <p className="mt-2 text-xs leading-5 text-muted-foreground">{t("copyFunding.hint")}</p>
    {query.isPending ? <p role="status" className="mt-3 text-xs">{t("executionWallets.loading")}</p> : null}
    {query.isError ? <div className="mt-3"><p role="alert" className="text-xs text-warning">{t("copyFunding.error")}</p><Button loading={query.isFetching} size="sm" variant="secondary" className="mt-2" onClick={() => void query.refetch()}>{t("executionWallets.retry")}</Button></div> : null}
    {data && !data.available ? <p className="mt-3 text-xs text-muted-foreground">{t("copyFunding.unavailable")}</p> : null}
    {data?.available && eligible.length ? <form className="mt-3 flex flex-wrap items-end gap-3" onSubmit={(event) => {
      event.preventDefault(); if (!accountId || !valid || pending || busy || query.isError) return;
      const idempotencyKey = key ?? crypto.randomUUID(); setKey(idempotencyKey);
      prepare.mutate({ accountId, amount, idempotencyKey }, { onSuccess: () => setKey(null) });
    }}>
      <div className="min-w-0 flex-1"><label htmlFor={selectId} className="block text-xs font-semibold">{t("executionWallets.strategy")}</label>
        <Select id={selectId} className="mt-1 w-full" value={accountId} disabled={busy || pending || Boolean(key)} placeholder={t("executionWallets.selectStrategy")} onValueChange={(value) => { setAccountId(value); prepare.reset(); }} options={eligible.map((a) => ({ value: a.id, label: t("executionWallets.copyNumber", { id: a.strategyId }) }))} /></div>
      <div><label htmlFor={amountId} className="block text-xs font-semibold">{t("copyFunding.amount")}</label><input id={amountId} inputMode="decimal" className="mt-1 w-32 rounded-xl bg-inset px-3 py-2 text-sm" value={amount} disabled={busy || pending || Boolean(key)} onChange={(e) => { setAmount(e.target.value); prepare.reset(); }} /></div>
      <Button size="sm" type="submit" loading={prepare.isPending} disabled={!(prepare.isPending) && (!accountId || !valid || pending || busy || query.isError)}>{t("copyFunding.prepare")}</Button>
      {key && !pending && !busy ? <Button size="sm" variant="secondary" type="button" /* busy-exempt: the button leaves with the key; the refetch is the list's own */ onClick={() => { setKey(null); prepare.reset(); void query.refetch(); }}>{t("executionWallets.cancel")}</Button> : null}
    </form> : null}
    {prepare.isError || confirm.isError || confirm.recovery.isError || cancel.isError ? <p role="alert" className="mt-3 text-xs text-warning">{t("copyFunding.error")}</p> : null}
    {pending ? <p className="mt-3 text-xs text-muted-foreground">{t("copyFunding.pendingHint")}</p> : null}
    {!operations.length && data ? <p className="mt-3 text-xs text-muted-foreground">{t("copyFunding.empty")}</p> : null}
    {operations.length ? <p className="mt-3 text-xs text-muted-foreground">{t("copyFunding.historyHint")}</p> : null}
    <div className="mt-3 space-y-3">{operations.map((op) => <article key={op.id} className="rounded-xl bg-raised/50 p-3">
      <div className="flex flex-wrap justify-between gap-2 text-xs font-semibold"><h5>{t("executionWallets.copyNumber", { id: op.strategyId })} · {t(`executionWallets.networks.${op.network}`)}</h5><span>{t(`copyFunding.states.${op.status === "prepared" && confirm.recovery.data?.includes(op.id) ? "unknown" : op.status}`)}</span></div>
      <dl className="mt-2 space-y-2 text-xs">
        <div><dt className="text-muted-foreground">{t("copyFunding.source")}</dt><dd className="break-all font-mono">{op.address}</dd></div>
        <div><dt className="text-muted-foreground">{t("copyFunding.destination")}</dt><dd className="break-all font-mono">{op.destination}</dd></div>
        <div><dt className="text-muted-foreground">{t("copyFunding.amount")}</dt><dd>{op.amount} USDC</dd></div>
        {op.creditedAmount !== null ? <div><dt className="text-muted-foreground">{t("copyFunding.received")}</dt><dd>{op.creditedAmount} USDC · {t("copyFunding.fee")}: {op.fee} USDC</dd></div> : null}
        <div><dt className="text-muted-foreground">{t("copyFunding.created")}</dt><dd>{format.dateTime(op.createdAt)}</dd></div>
        <div><dt className="text-muted-foreground">{t("copyFunding.updated")}</dt><dd>{format.dateTime(op.updatedAt)}</dd></div>
        {op.transactionHash ? <div><dt className="text-muted-foreground">{t("copyFunding.hash")}</dt><dd className="flex items-center gap-2"><span className="min-w-0 break-all font-mono">{op.transactionHash}</span><CopyIconButton value={op.transactionHash} /></dd></div> : null}
      </dl>
      <div className="mt-3 flex flex-wrap gap-2">
        {op.status === "prepared" && op.direction !== "to_main" && !confirm.recovery.data?.includes(op.id) ? <Button size="sm" loading={confirm.isPending && confirm.variables?.id === op.id} disabled={!(confirm.isPending && confirm.variables?.id === op.id) && (busy || query.isError || !data?.available || !confirm.recovery.isSuccess || !accounts.some(a => a.id === op.accountId && a.strategyId === op.strategyId && a.network === op.network && a.address === op.destination && a.state === "ready") || walletAddress !== op.address || op.network !== "testnet")} onClick={() => confirm.mutate(op)}>{confirm.isPending ? t("copyFunding.signing") : t("copyFunding.confirm")}</Button> : null}
        {(["unknown", "accepted"].includes(op.status) || op.status === "prepared" && confirm.recovery.data?.includes(op.id)) ? <Button size="sm" variant="secondary" loading={confirm.isPending && confirm.variables?.id === op.id} disabled={!(confirm.isPending && confirm.variables?.id === op.id) && (busy || query.isError)} onClick={() => confirm.mutate(op)}>{t("copyFunding.reconcile")}</Button> : null}
        {op.canCancel && !confirm.recovery.data?.includes(op.id) ? <Button size="sm" variant="secondary" loading={cancel.isPending && cancel.variables === op.id} disabled={!(cancel.isPending && cancel.variables === op.id) && (busy || query.isError || !confirm.recovery.isSuccess)} onClick={() => cancel.mutate(op.id)}>{t("executionWallets.cancel")}</Button> : null}
      </div>
    </article>)}</div>
  </section>;
}
