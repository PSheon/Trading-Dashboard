"use client";

import { useState } from "react";
import type { LiveCopySetup, LiveCopyStrategy } from "@trading-dashboard/shared/contracts";

import { LiveCopyConfirm, LiveCopyProgress, liveSetupError, useCopyTexts, useLiveSetupText } from "@/components/copy/live-copy-setup-dialogs";
import { LiveSettingsFields } from "@/components/copy/live-copy-settings-fields";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/dialog";
import { fill } from "@/i18n/live-setup";
import { useI18n } from "@/i18n/provider";
import { apiErrorCode } from "@/lib/api";
import { copyErrorText } from "@/lib/copy-error-text";
import { amountInput } from "@/lib/amount-input";
import { setupTerminal, useLiveCopySetupActions } from "@/lib/copy-live-setup";
import type { LiveCopyItem } from "@/lib/copy-live-portfolio";

/**
 * A testnet copy's one-click actions in the portfolio (plan §4 parity):
 * 繼續設定 (the progress dialog of its unfinished setup, which hands a
 * consent still due to the confirm sheet), 重新開始 / 取消設定 for a setup
 * that ended or whose consent lapsed, 暫停 / 恢復 (no
 * signature), 編輯設定 and 續期 (one silent signature behind Orbie's confirm
 * sheet), and 加碼 (a silent UsdSend from the main wallet).
 */
export function LiveCopyActions({ item, strategy }: { item: LiveCopyItem; strategy: LiveCopyStrategy | null }) {
  const text = useLiveSetupText(), texts = useCopyTexts(), { format } = useI18n();
  const actions = useLiveCopySetupActions();
  const [progressId, setProgressId] = useState<string | null>(null);
  const [pendingSetup, setPendingSetup] = useState<LiveCopySetup | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [toppingUp, setToppingUp] = useState(false);
  const [topUpError, setTopUpError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const unfinished = item.setup && !setupTerminal(item.setup) ? item.setup : null;
  // Waiting for a consent that can no longer be signed: 重新開始 or 取消設定.
  const lapsed = unfinished?.stage === "awaiting_consent" && item.setup?.consent === null ? unfinished : null;
  const stopped = item.setup && ["failed", "expired"].includes(item.setup.stage) ? item.setup : null;
  const running = item.stage === "active" || item.stage === "paused" || item.stage === "starting";
  const mandateId = item.mandate?.id ?? null;
  const busy = actions.pause.isPending || actions.resume.isPending || actions.edit.isPending || actions.renew.isPending || actions.topUp.isPending || actions.restart.isPending || actions.cancel.isPending;
  const message = (err: unknown) => copyErrorText(texts, err);
  const fail = (err: unknown) => setError(message(err));
  const review = (setup: LiveCopySetup) => {
    if (setup.stage === "awaiting_consent" && setup.consent) { setConfirmError(null); setProgressId(null); setPendingSetup(setup); }
    else setProgressId(setup.id);
  };
  const restart = (setup: LiveCopySetup | string) => { setError(null); actions.restart.mutate(setup, { onSuccess: review, onError: fail }); };
  const cancel = (id: string) => { setError(null); actions.cancel.mutate(id, { onError: fail }); };
  const confirm = async () => {
    if (!pendingSetup) return;
    try { const done = await actions.confirm.mutateAsync(pendingSetup); setPendingSetup(null); setProgressId(done.id); }
    catch (err) {
      setConfirmError(message(err));
      // A fresh challenge for the same terms; the owner confirms again.
      if (apiErrorCode(err) === "consent_expired") actions.restart.mutate(pendingSetup, { onSuccess: (next) => { if (next.consent) setPendingSetup(next); } });
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {item.expiresAt && running ? (
        <p className={item.renewalDue ? "text-xs font-semibold text-warning" : "text-xs text-muted-foreground"}>
          {fill(item.renewalDue ? text.renewDue : text.expiresOn, { date: format.date(item.expiresAt) })}
        </p>
      ) : null}
      {stopped ? <p role="alert" className="text-xs text-warning">{liveSetupError(texts, stopped.issue)}</p> : null}
      {lapsed ? <p className="text-xs text-muted-foreground">{text.consentLapsedHint}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        {unfinished && !lapsed ? <Button size="sm" onClick={() => setProgressId(unfinished.id)}>{text.continueSetup}</Button> : null}
        {stopped || lapsed ? <Button size="sm" loading={actions.restart.isPending} disabled={busy && !actions.restart.isPending} onClick={() => restart((stopped ?? lapsed)!.id)}>{text.restart}</Button> : null}
        {stopped || lapsed ? <Button size="sm" variant="secondary" loading={actions.cancel.isPending} disabled={busy && !actions.cancel.isPending} onClick={() => cancel((stopped ?? lapsed)!.id)}>{text.cancelSetup}</Button> : null}
        {running && mandateId && item.status === "active" ? (
          <Button size="sm" variant="secondary" loading={actions.pause.isPending} disabled={busy && !actions.pause.isPending} onClick={() => actions.pause.mutate(mandateId, { onError: fail })}>{text.pause}</Button>
        ) : null}
        {running && mandateId && item.status === "paused" && item.mandate?.state === "paused" ? (
          <Button size="sm" variant="secondary" loading={actions.resume.isPending} disabled={busy && !actions.resume.isPending} onClick={() => actions.resume.mutate(mandateId, { onError: fail })}>{text.resume}</Button>
        ) : null}
        {running && strategy && !unfinished ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => { setError(null); setEditing(true); }}>{text.edit}</Button> : null}
        {(running || item.stage === "needs_deposit") && item.accountId && !item.pendingTransfer ? (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => { setError(null); setTopUpError(null); setToppingUp(true); }}>{text.topUp}</Button>
        ) : null}
        {running && item.renewalDue && !unfinished ? (
          <Button size="sm" loading={actions.renew.isPending} disabled={busy && !actions.renew.isPending} onClick={() => actions.renew.mutate({ strategyId: item.strategyId }, { onSuccess: review, onError: fail })}>{text.renew}</Button>
        ) : null}
      </div>
      {error ? <p role="alert" className="text-xs text-negative">{error}</p> : null}
      {editing && strategy ? (
        <EditDialog strategy={strategy} onClose={() => setEditing(false)} pending={actions.edit.isPending}
          onSave={(budgetUsd, settings) => actions.edit.mutate({ strategyId: item.strategyId, budgetUsd, settings }, { onSuccess: (setup) => { setEditing(false); review(setup); }, onError: fail })} />
      ) : null}
      {toppingUp && item.accountId ? (
        <TopUpDialog pending={actions.topUp.isPending} error={topUpError} onClose={() => setToppingUp(false)}
          onConfirm={(amount) => { setTopUpError(null); actions.topUp.mutate({ accountId: item.accountId!, amount }, { onSuccess: () => setToppingUp(false), onError: (err) => setTopUpError(message(err)) }); }} />
      ) : null}
      <LiveCopyConfirm setup={pendingSetup} open={pendingSetup !== null} onOpenChange={(open) => { if (!open && !actions.confirm.isPending) setPendingSetup(null); }}
        onConfirm={() => void confirm()} pending={actions.confirm.isPending || actions.restart.isPending} error={confirmError}
        note={actions.confirmPhase === "attaching" ? text.attachingSigner : null} />
      <LiveCopyProgress setupId={progressId} open={progressId !== null} onOpenChange={(open) => { if (!open) setProgressId(null); }}
        onConsent={review} onRetry={(setup) => { setProgressId(null); restart(setup); }} />
    </div>
  );
}

function EditDialog({ strategy, onClose, onSave, pending }: { strategy: LiveCopyStrategy; onClose: () => void; onSave: (budgetUsd: string, settings: LiveCopyStrategy["settings"]) => void; pending: boolean }) {
  const text = useLiveSetupText();
  const current = strategy.settings;
  const [budget, setBudget] = useState(strategy.budgetUsd);
  const [direction, setDirection] = useState(current.direction);
  const [sizing, setSizing] = useState<"ratio" | "fixed">(current.sizingMode === "fixed" ? "fixed" : "ratio");
  const [perTrade, setPerTrade] = useState(current.perTradeUsd === null ? "" : String(current.perTradeUsd));
  const [maxExposure, setMaxExposure] = useState(current.maxTotalExposureUsd === null ? "" : String(current.maxTotalExposureUsd));
  const [maxLeverage, setMaxLeverage] = useState(current.maxLeverage === null ? "" : String(current.maxLeverage));
  const per = sizing === "fixed" ? Number.parseFloat(perTrade) : null;
  const valid = Number(budget) > 0 && (sizing === "ratio" || (per !== null && per > 0));
  return (
    <Modal open onOpenChange={(open) => { if (!open && !pending) onClose(); }} title={text.edit}>
      <form className="flex flex-col gap-3 px-6 pt-3 pb-6" onSubmit={(event) => {
        event.preventDefault();
        if (!valid) return;
        const exposure = Number.parseFloat(maxExposure), leverage = Number.parseFloat(maxLeverage);
        onSave(budget, { direction, sizingMode: sizing, perTradeUsd: per, maxTotalExposureUsd: exposure > 0 ? exposure : null, maxLeverage: leverage >= 1 ? Math.min(50, leverage) : null, copyStartMode: "delta" });
      }}>
        <label className="flex items-center justify-between gap-3 text-[13px] font-semibold">{text.budget}
          <input inputMode="decimal" value={budget} onChange={(e) => setBudget(amountInput(e.target.value, budget).slice(0, 12))} className="num h-10 w-28 rounded-xl bg-inset px-3 text-right text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        </label>
        <div className="flex items-center justify-between gap-3 text-[13px] font-semibold">
          <span>{text.direction}</span>
          <div role="radiogroup" aria-label={text.direction} className="flex gap-1 rounded-full bg-inset p-1">
            {(["same", "reverse"] as const).map((d) => (
              <button key={d} type="button" role="radio" aria-checked={direction === d} onClick={() => setDirection(d)}
                className={direction === d ? "min-h-9 rounded-full bg-primary px-3 text-xs font-extrabold text-primary-foreground" : "min-h-9 rounded-full px-3 text-xs font-extrabold text-muted-foreground"}>{d === "same" ? text.same : text.reverse}</button>
            ))}
          </div>
        </div>
        <LiveSettingsFields text={text} sizing={sizing} setSizing={setSizing} perTrade={perTrade} setPerTrade={setPerTrade} maxExposure={maxExposure} setMaxExposure={setMaxExposure} maxLeverage={maxLeverage} setMaxLeverage={setMaxLeverage} />
        <Button type="submit" className="mt-2" loading={pending} disabled={!pending && !valid}>{text.save}</Button>
      </form>
    </Modal>
  );
}

/** 加碼: the amount stays typed when sending fails, with the reason. */
function TopUpDialog({ onClose, onConfirm, pending, error }: { onClose: () => void; onConfirm: (amount: string) => void; pending: boolean; error: string | null }) {
  const text = useLiveSetupText();
  const [amount, setAmount] = useState("");
  const valid = /^\d+(?:\.\d{1,6})?$/.test(amount) && Number(amount) > 0;
  return (
    <Modal open onOpenChange={(open) => { if (!open && !pending) onClose(); }} title={text.topUp}>
      <form className="flex flex-col gap-3 px-6 pt-3 pb-6" onSubmit={(event) => { event.preventDefault(); if (valid) onConfirm(amount); }}>
        <label className="flex items-center justify-between gap-3 text-[13px] font-semibold">USDC
          <input inputMode="decimal" autoFocus value={amount} onChange={(e) => setAmount(amountInput(e.target.value, amount).slice(0, 12))} className="num h-10 w-32 rounded-xl bg-inset px-3 text-right text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring" placeholder="0" />
        </label>
        <p className="text-xs leading-5 text-muted-foreground">{text.testnetNote} {text.signNote}</p>
        {error ? <p role="alert" className="text-xs text-negative">{error}</p> : null}
        <Button type="submit" loading={pending} disabled={!pending && !valid}>{fill(text.topUpConfirm, { amount: amount || "0" })}</Button>
      </form>
    </Modal>
  );
}
