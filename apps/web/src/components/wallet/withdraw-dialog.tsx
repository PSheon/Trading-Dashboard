"use client";

import { Loader2, TriangleAlert } from "lucide-react";
import { useId, useState } from "react";

import { ErrorState, Skeleton } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { useI18n } from "@/i18n/provider";
import { useAuth } from "@/lib/auth";
import type { WalletSummary } from "@/lib/contracts";
import { WITHDRAW_FEE_USDC, networkConfig, usdcString } from "@/lib/hyperliquid-network";
import { signErrorMessage, useWallet, useWithdraw } from "@/lib/wallet";
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

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={t("wallet.withdrawTitle")} badge={<NetworkBadge network={summary?.network} />}>
      {wallet.isError && !summary ? (
        <ErrorState message={wallet.error.message} onRetry={() => wallet.refetch()} />
      ) : !summary ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-14 w-full rounded-full" />
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
  const withdraw = useWithdraw();
  const [destination, setDestination] = useState("");
  const [amount, setAmount] = useState("");
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
        if (!ready || withdraw.isPending) return;
        // CopyDog's three toasts: "Withdrawing $X…" (no icon) while signing,
        // then the submitted confirmation (and the modal closes) or the error.
        const pending = toast.info(t("wallet.withdrawSubmitting", { amount: format.usd(Number(amount), { digits: 2 }) }), { icon: false });
        withdraw.mutate(
          { summary, destination: destination.trim(), amount: amount.trim() },
          {
            onSuccess: () => {
              toast.dismiss(pending);
              toast.success(t("wallet.withdrawSent"));
              onDone();
            },
            onError: (err) => {
              toast.dismiss(pending);
              const error = signErrorMessage(err);
              toast.error(error.rejected ? t("wallet.rejected") : t("wallet.signFailed", { message: error.message }));
            },
          },
        );
      }}
    >
      <label htmlFor={destId} className="text-sm font-semibold">
        {t("wallet.destination")}
      </label>
      <input
        id={destId}
        value={destination}
        onChange={(e) => setDestination(e.target.value)}
        placeholder={t("wallet.destinationPlaceholder")}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={problem === "address"}
        className="mt-2.5 h-12 rounded-xl border border-border-strong bg-raised px-4 font-mono text-sm outline-none placeholder:font-sans placeholder:text-subtle-foreground focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-negative"
      />

      <label htmlFor={amountId} className="mt-6 text-sm font-semibold">
        {t("wallet.amount")}
      </label>
      <input
        id={amountId}
        value={amount}
        onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
        placeholder="0.00"
        inputMode="decimal"
        autoComplete="off"
        aria-invalid={problem === "belowMin" || problem === "overAvailable"}
        className="num mt-2.5 h-12 rounded-xl border border-border-strong bg-raised px-4 text-sm outline-none placeholder:text-subtle-foreground focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-negative"
      />
      <div className="mt-1.5 flex items-center justify-between text-xs">
        <span className="num text-muted-foreground">{t("wallet.available", { amount: format.usd(withdrawable, { digits: 2 }) })}</span>
        <button
          type="button"
          className="font-semibold text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-45"
          disabled={withdrawable <= 0}
          onClick={() => setAmount(usdcString(withdrawable))}
        >
          {t("wallet.max")}
        </button>
      </div>

      {problemText ? (
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

      <Button type="submit" size="xl" className="mt-5 w-full" disabled={!ready || !wallet?.address || withdraw.isPending}>
        {withdraw.isPending ? <Loader2 className="animate-spin" /> : null}
        {withdraw.isPending ? t("wallet.withdrawing") : t("wallet.withdrawTitle")}
      </Button>
      {!wallet ? <p className="mt-2 text-center text-xs text-muted-foreground">{t("wallet.unavailableDemo")}</p> : null}
    </form>
  );
}
