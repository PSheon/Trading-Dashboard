"use client";

import { ArrowDownToLine, Check, Info, TriangleAlert } from "lucide-react";

import { ErrorState, SkelBar, SkelCircle } from "@/components/page";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";

import { useI18n } from "@/i18n/provider";
import { useAuth } from "@/lib/auth";
import type { WalletSummary } from "@/lib/contracts";
import { MIN_BRIDGE_USDC, networkConfig } from "@/lib/hyperliquid-network";
import { signErrorMessage, useBridgeDeposit, useWallet } from "@/lib/wallet";
import { AddressQr, ArbitrumIcon, CopyIconButton, NetworkBadge, useCopy } from "./bits";

/** Below this much ETH the bridge transfer asks Privy to sponsor the gas
 * (an ERC-20 transfer on Arbitrum costs well under this). */
const GAS_ETH = 0.00002;

/**
 * CopyDog's 儲值 modal: network (Arbitrum), QR of the deposit address with
 * the USDC mark, the address with a copy icon, 「僅可發送 Arbitrum 鏈上的
 * USDC · 最低 $X」 and 複製地址. The address is the user's main account, so
 * USDC sent there sits on Arbitrum until it is bridged; when some is there,
 * a card offers the one-click bridge (signed by the user's own wallet).
 * Copying confirms with CopyDog's "儲值地址已複製！" toast.
 */
export function DepositDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const wallet = useWallet();
  const summary = wallet.data;
  const addressCopied = () => toast.success(t("wallet.addressCopied"));
  const [copied, copy] = useCopy(addressCopied);
  const network = summary ? networkConfig(summary.network) : null;

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={t("wallet.depositTitle")} badge={<NetworkBadge network={summary?.network} />}>
      {wallet.isError && !summary ? (
        <ErrorState onRetry={() => wallet.refetch()} />
      ) : !summary || !network ? (
        // The chain picker, the QR code, the address row, the note and the
        // button, while the wallet is read.
        <div aria-hidden="true" className="ui-skeleton flex flex-col items-center gap-4 [--skel-bar:var(--border)]">
          <span className="flex h-12 w-full items-center gap-2.5 rounded-xl bg-raised px-4">
            <SkelCircle className="size-[22px]" />
            <SkelBar className="h-3 w-28" />
          </span>
          <span className="size-[196px] rounded-xl bg-raised" />
          <span className="flex h-12 w-full items-center gap-2 rounded-xl bg-raised py-2 pr-2 pl-4">
            <SkelBar className="mx-auto h-3 w-64 max-w-full" />
            <SkelCircle className="size-8 rounded-lg" />
          </span>
          <SkelBar line="h-4" className="h-2.5 w-60 max-w-full bg-raised" />
          <span className="h-14 w-full rounded-full bg-raised" />
        </div>
      ) : !summary.address ? (
        <p className="rounded-xl bg-raised p-4 text-sm text-muted-foreground">{t("wallet.noWallet")}</p>
      ) : (
        <div className="flex flex-col items-center gap-4">
          <Select
            className="w-full"
            label={t("executionWallets.network")}
            value={network.chainLabel}
            onValueChange={() => undefined}
            options={[{ value: network.chainLabel, label: <span className="inline-flex items-center gap-2.5"><ArbitrumIcon size={22} />{network.chainLabel}</span>, text: network.chainLabel }]}
          />

          <AddressQr value={summary.address} label={t("wallet.qrLabel")} />

          <div className="flex w-full items-center gap-2 rounded-xl bg-raised py-2 pr-2 pl-4">
            <span className="min-w-0 flex-1 truncate text-center font-mono text-[0.8125rem]">{summary.address}</span>
            <CopyIconButton value={summary.address} onCopied={addressCopied} />
          </div>

          <p className="flex items-center gap-1.5 text-center text-xs text-muted-foreground">
            <Info className="size-3.5 shrink-0" />
            {t("wallet.depositNote", { chain: network.chainLabel, min: MIN_BRIDGE_USDC })}
          </p>

          <PendingBridge summary={summary} />

          <Button size="cta" className="w-full" onClick={() => copy(summary.address!)}>
            {copied ? <Check /> : null}
            {copied ? t("wallet.copied") : t("wallet.copyAddress")}
          </Button>
        </div>
      )}
    </Modal>
  );
}

/** USDC waiting at the deposit address on Arbitrum → bridge it. */
function PendingBridge({ summary }: { summary: WalletSummary }) {
  const { t, format } = useI18n();
  const toast = useToast();
  const { wallet } = useAuth();
  const usdc = summary.arbitrum?.usdc ?? 0;
  const network = networkConfig(summary.network);
  const needsSponsor = (summary.arbitrum?.eth ?? 0) < GAS_ETH;
  // A failed bridge is a toast, as CopyDog's wallet errors are; it belongs
  // to the mutation, so closing the dialog during Privy's prompt keeps it.
  // The SDK's own (English) message is never shown.
  const bridge = useBridgeDeposit({
    onError: (err) => toast.error(signErrorMessage(err).rejected ? t("wallet.rejected") : `${t("common.errors.failed")}${needsSponsor ? ` ${t("wallet.noGas", { chain: network.chainLabel })}` : ""}`),
  });
  if (usdc <= 0) return null;
  const belowMin = usdc < MIN_BRIDGE_USDC;

  return (
    <div className="w-full rounded-2xl border border-primary/30 bg-primary-soft/40 p-4">
      <p className="text-sm font-semibold">{t("wallet.pendingTitle", { amount: format.num(usdc, 2) })}</p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t("wallet.pendingBody")}</p>
      {belowMin ? (
        <p className="mt-2 flex gap-1.5 text-xs text-warning">
          <TriangleAlert className="mt-px size-3.5 shrink-0" />
          {t("wallet.bridgeBelowMin", { min: MIN_BRIDGE_USDC })}
        </p>
      ) : null}
      <Button
        className="mt-3 w-full"
        variant="secondary"
        loading={bridge.isPending}
        disabled={!bridge.isPending && (!wallet?.address || belowMin || bridge.isSuccess)}
        onClick={() => bridge.mutate({ summary, sponsor: needsSponsor })}
      >
        {bridge.isSuccess ? <Check /> : <ArrowDownToLine />}
        {bridge.isPending ? t("wallet.bridging") : bridge.isSuccess ? t("wallet.bridgeSent") : t("wallet.bridge")}
      </Button>
      {!wallet ? <p className="mt-2 text-center text-xs text-muted-foreground">{t("wallet.unavailableDemo")}</p> : null}
    </div>
  );
}
