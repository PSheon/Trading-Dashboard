"use client";

import { Loader2, TriangleAlert } from "lucide-react";
import { useIsMutating } from "@tanstack/react-query";
import { useId, useState } from "react";

import { ErrorState, SkelBar } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { useI18n } from "@/i18n/provider";
import { useAuth } from "@/lib/auth";
import type { WalletSummary } from "@/lib/contracts";
import { WITHDRAW_FEE_USDC, networkConfig, usdcString } from "@/lib/hyperliquid-network";
import { apiErrorCode } from "@/lib/api";
import { amountInput } from "@/lib/amount-input";
import { signErrorMessage, useWallet, useWithdraw, useWithdrawalRecovery, useCancelWithdrawalPreparation, WITHDRAW_MUTATION_KEY } from "@/lib/wallet";
import type { Translate } from "@/i18n/provider";
import { NetworkBadge } from "./bits";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const AMOUNT = /^\d+(?:\.\d{0,6})?$/;

export type WithdrawProblem = "address" | "belowMin" | "overAvailable" | null;

/** Pure validation, shared with tests: what's wrong with this input, if
 * anything. An empty field is "not ready", not an error to show. */
export function withdrawProblem(destination: string, amount: string, withdrawable: number): { ready: boolean; problem: WithdrawProblem } {
  const dest = destination.trim();
  const amt = amount.trim();
  if (dest && !ADDRESS.test(dest)) return { ready: false, problem: "address" };
  if (!amt || !AMOUNT.test(amt)) return { ready: false, problem: null };
  const value = Number(amt);
  if (value <= WITHDRAW_FEE_USDC) return { ready: false, problem: "belowMin" };
  if (value > withdrawable + 1e-9) return { ready: false, problem: "overAvailable" };
  return { ready: Boolean(dest), problem: null };
}

/** What a failed withdrawal tells the user. The api's answers (busy, rate
 * limited, the journal's codes) and a lost connection are not signing
 * failures; only what the wallet itself threw reads as one. */
export function withdrawErrorText(err: unknown, t: Translate, recoveryText: string): string {
  const code = apiErrorCode(err) ?? (err instanceof Error ? err.message : "");
  if (code === "withdrawal_unknown" || code === "withdrawal_pending") return recoveryText;
  if (code === "withdrawal_rejected") return t("wallet.withdrawRejected");
  if (code === "withdrawal_identity_mismatch") return t("wallet.noWallet");
  const status = (err as { status?: unknown } | null)?.status;
  if (status === 429) return t("common.errors.rateLimited");
  if (status === 502 || status === 503 || status === 504) return t("common.errors.busy");
  if (typeof status === "number" || (err instanceof TypeError && /fetch|network|load failed/i.test(err.message))) return t("common.errors.failed");
  const error = signErrorMessage(err);
  return error.rejected ? t("wallet.rejected") : t("wallet.signFailed", { message: error.message });
}

/**
 * CopyDog's 提款 modal: 目標地址, 金額（USDC） with 可用 / 最大, 「僅可提取
 * USDC 至 Arbitrum 鏈 · $1 網路費用」 and 提款 (disabled until valid). The
 * user's own Privy wallet signs `withdraw3` in the browser; Hyperliquid
 * takes the $1 fee from the amount and pays out on Arbitrum in minutes.
 */
export function WithdrawDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n();
  const wallet = useWallet();
  const summary = wallet.data;
  // While a withdrawal is being signed and sent the modal stays open: its
  // result (sent, rejected, needs recovery) is what the user waits for.
  const sending = useIsMutating({ mutationKey: WITHDRAW_MUTATION_KEY }) > 0;

  return (
    <Modal open={open} onOpenChange={(next) => { if (!next && sending) return; onOpenChange(next); }} title={t("wallet.withdrawTitle")} badge={<NetworkBadge network={summary?.network} />}>
      {wallet.isError && !summary ? (
        <ErrorState onRetry={() => wallet.refetch()} />
      ) : !summary ? (
        // The form's own labels and fields, the 可用 / 最大 line, the note
        // and the button, while the wallet is read.
        <div aria-hidden="true" className="ui-skeleton flex flex-col">
          <span className="text-sm font-semibold">{t("wallet.destination")}</span>
          <span className="mt-2.5 h-12 rounded-xl bg-inset" />
          <span className="mt-6 text-sm font-semibold">{t("wallet.amount")}</span>
          <span className="mt-2.5 h-12 rounded-xl bg-inset" />
          <span className="mt-1.5 flex items-center justify-between">
            <SkelBar line="h-4" className="h-2.5 w-28" />
            <SkelBar line="h-4" className="h-2.5 w-8" />
          </span>
          <SkelBar line="mt-6 h-4 justify-center" className="h-2.5 w-64 max-w-full" />
          <span className="mt-5 h-14 rounded-full bg-raised" />
        </div>
      ) : !summary.address ? (
        <p className="rounded-xl bg-raised p-4 text-sm text-muted-foreground">{t("wallet.noWallet")}</p>
      ) : (
        // Keyed so a reopened modal starts clean.
        <WithdrawForm key={open ? "open" : "closed"} summary={summary} onDone={() => onOpenChange(false)} />
      )}
    </Modal>
  );
}

function WithdrawForm({ summary, onDone }: { summary: WalletSummary; onDone: () => void }) {
  const { t, format } = useI18n();
  const toast = useToast();
  const { wallet } = useAuth();
  const recoveryText = t("wallet.withdrawRecovery");
  // On the mutation, so the result toast survives the form unmounting.
  const withdraw = useWithdraw({
    onSuccess: (_data, variables) => {
      if (variables.toastId !== undefined) toast.dismiss(variables.toastId);
      toast.success(t("wallet.withdrawSent"));
      onDone();
    },
    onError: (err, variables) => {
      if (variables.toastId !== undefined) toast.dismiss(variables.toastId);
      toast.error(withdrawErrorText(err, t, recoveryText));
    },
  });
  const cancel = useCancelWithdrawalPreparation();
  const [destinationInput, setDestination] = useState("");
  const [amountInputValue, setAmount] = useState("");
  const recovery = useWithdrawalRecovery(summary);
  const pendingOperation = recovery.data?.status === "unknown" || recovery.data?.status === "prepared" ? recovery.data : null;
  const destination = pendingOperation?.destination ?? destinationInput;
  const amount = pendingOperation?.amount ?? amountInputValue;
  const recovering = Boolean(pendingOperation);
  const checking = pendingOperation?.status === "unknown";
  const destId = useId();
  const amountId = useId();
  const network = networkConfig(summary.network);
  const withdrawable = summary.hyperliquid?.withdrawable ?? 0;
  const { ready, problem } = withdrawProblem(destination, amount, withdrawable);

  const problemText =
    problem === "address"
      ? t("wallet.invalidAddress")
      : problem === "belowMin"
        ? t("wallet.belowMin", { min: WITHDRAW_FEE_USDC, fee: WITHDRAW_FEE_USDC })
        : problem === "overAvailable"
          ? t("wallet.overAvailable")
          : null;

  return (
    <form
      className="flex flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        if ((!ready && !recovering) || withdraw.isPending || cancel.isPending || recovery.isPending || recovery.isError) return;
        // CopyDog's three toasts: "Withdrawing $X…" (no icon) while signing,
        // then the submitted confirmation (and the modal closes) or the error.
        const pending = toast.info(checking ? t("wallet.checkWithdrawal") : t("wallet.withdrawSubmitting", { amount: format.usd(Number(amount), { digits: 2 }) }), { icon: false });
        withdraw.mutate({ summary, destination: destination.trim(), amount: amount.trim(), operationId: pendingOperation?.id, toastId: pending });
      }}
    >
      {checking && !pendingOperation?.canCancel ? <p role="status" className="mb-4 rounded-xl bg-raised p-3 text-sm text-muted-foreground">{recoveryText}<span className="num mt-2 block text-xs">ID: {pendingOperation?.nonce}</span></p> : null}
      {pendingOperation && (pendingOperation.status === "prepared" || pendingOperation.canCancel) ? (
        <div className="mb-4 rounded-xl bg-raised p-3 text-sm text-muted-foreground">
          <p>{t("wallet.withdrawPrepared")}</p>
          <Button type="button" variant="secondary" size="sm" className="mt-3" disabled={cancel.isPending || withdraw.isPending || recovery.isError} onClick={() => cancel.mutate(pendingOperation.id, { onError: () => toast.error(t("common.error")) })}>
            {cancel.isPending ? t("wallet.cancellingPreparation") : t("wallet.cancelPreparation")}
          </Button>
        </div>
      ) : null}
      {recovery.isError ? <ErrorState onRetry={() => void recovery.refetch()} /> : null}
      <label htmlFor={destId} className="text-sm font-semibold">
        {t("wallet.destination")}
      </label>
      <input
        id={destId}
        disabled={recovering}
        value={destination}
        onChange={(e) => setDestination(e.target.value)}
        placeholder={t("wallet.destinationPlaceholder")}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={problem === "address"}
        className="mt-2.5 h-12 rounded-xl border-2 border-transparent bg-inset px-4 font-bold focus-visible:border-primary font-mono text-sm outline-none placeholder:font-sans placeholder:text-subtle-foreground focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-negative"
      />

      <label htmlFor={amountId} className="mt-6 text-sm font-semibold">
        {t("wallet.amount")}
      </label>
      <input
        id={amountId}
        disabled={recovering}
        value={amount}
        onChange={(e) => setAmount(amountInput(e.target.value, amount))}
        placeholder="0.00"
        inputMode="decimal"
        autoComplete="off"
        aria-invalid={problem === "belowMin" || problem === "overAvailable"}
        className="num mt-2.5 h-12 rounded-xl border-2 border-transparent bg-inset px-4 font-bold focus-visible:border-primary text-sm outline-none placeholder:text-subtle-foreground focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-negative"
      />
      <div className="mt-1.5 flex items-center justify-between text-xs">
        <span className="num text-muted-foreground">{t("wallet.available", { amount: format.usd(withdrawable, { digits: 2 }) })}</span>
        <button
          type="button"
          className="font-semibold text-primary-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-45"
          disabled={withdrawable <= 0 || recovering}
          onClick={() => setAmount(usdcString(withdrawable))}
        >
          {t("wallet.max")}
        </button>
      </div>

      {!recovering && problemText ? (
        <p role="alert" className="mt-2 text-xs text-negative">
          {problemText}
        </p>
      ) : ready ? (
        <p className="num mt-2 text-xs text-muted-foreground">
          {t("wallet.receive", { amount: format.usd(Number(amount) - WITHDRAW_FEE_USDC, { digits: 2 }) })}
        </p>
      ) : null}

      <p className="mt-6 flex items-center justify-center gap-1.5 text-center text-xs text-muted-foreground">
        <TriangleAlert className="size-3.5 shrink-0 text-warning" />
        {t("wallet.withdrawNote", { chain: network.chainLabel, fee: WITHDRAW_FEE_USDC })}
      </p>

      <Button type="submit" size="xl" className="mt-5 w-full" disabled={(!ready && !recovering) || (!wallet?.address && !checking) || withdraw.isPending || cancel.isPending || recovery.isPending || recovery.isError}>
        {withdraw.isPending ? <Loader2 className="animate-spin" /> : null}
        {withdraw.isPending ? checking ? t("common.loading") : t("wallet.withdrawing") : checking ? t("wallet.checkWithdrawal") : t("wallet.withdrawTitle")}
      </Button>
      {!wallet ? <p className="mt-2 text-center text-xs text-muted-foreground">{t("wallet.unavailableDemo")}</p> : null}
    </form>
  );
}
