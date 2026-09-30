"use client";

import { ArrowDownToLine, Check, ChevronDown, Info, Loader2, TriangleAlert } from "lucide-react";
import { cn } from "cn";

import { ErrorState, Skeleton } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
 */
export function DepositDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n();
  const wallet = useWallet();
  const summary = wallet.data;
  const [copied, copy] = useCopy();
  const network = summary ? networkConfig(summary.network) : null;

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={t("wallet.depositTitle")} badge={<NetworkBadge network={summary?.network} />}>
      {wallet.isError && !summary ? (
        <ErrorState message={wallet.error.message} onRetry={() => wallet.refetch()} />
      ) : !summary || !network ? (
        <div className="flex flex-col items-center gap-4">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="size-[196px]" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-14 w-full rounded-full" />
        </div>
      ) : !summary.address ? (
        <p className="rounded-xl bg-raised p-4 text-sm text-muted-foreground">{t("wallet.noWallet")}</p>
      ) : (
        <div className="flex flex-col items-center gap-4">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex h-12 w-full items-center gap-2.5 rounded-xl bg-raised px-4 text-left text-sm font-semibold outline-none transition-colors hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ArbitrumIcon size={22} />
                <span className="flex-1">{network.chainLabel}</span>
                <ChevronDown className="size-4 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)]">
              <DropdownMenuRadioGroup value={network.chainLabel}>
                <DropdownMenuRadioItem value={network.chainLabel}>{network.chainLabel}</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <AddressQr value={summary.address} label={t("wallet.qrLabel")} />

          <div className="flex w-full items-center gap-2 rounded-xl bg-raised py-2 pr-2 pl-4">
            <span className="min-w-0 flex-1 truncate text-center font-mono text-[0.8125rem]">{summary.address}</span>
            <CopyIconButton value={summary.address} />
          </div>

          <p className="flex items-center gap-1.5 text-center text-xs text-muted-foreground">
            <Info className="size-3.5 shrink-0" />
            {t("wallet.depositNote", { chain: network.chainLabel, min: MIN_BRIDGE_USDC })}
          </p>

          <PendingBridge summary={summary} />

          <Button size="xl" className="w-full" onClick={() => copy(summary.address!)}>
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
  const { wallet } = useAuth();
  const bridge = useBridgeDeposit();
  const usdc = summary.arbitrum?.usdc ?? 0;
  if (usdc <= 0) return null;
  const network = networkConfig(summary.network);
  const belowMin = usdc < MIN_BRIDGE_USDC;
  const needsSponsor = (summary.arbitrum?.eth ?? 0) < GAS_ETH;
  const error = bridge.error ? signErrorMessage(bridge.error) : null;

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
        disabled={!wallet?.address || belowMin || bridge.isPending || bridge.isSuccess}
        onClick={() => bridge.mutate({ summary, sponsor: needsSponsor })}
      >
        {bridge.isPending ? <Loader2 className="animate-spin" /> : bridge.isSuccess ? <Check /> : <ArrowDownToLine />}
        {bridge.isPending ? t("wallet.bridging") : bridge.isSuccess ? t("wallet.bridgeSent") : t("wallet.bridge")}
      </Button>
      {!wallet ? <p className="mt-2 text-center text-xs text-muted-foreground">{t("wallet.unavailableDemo")}</p> : null}
      {error ? (
        <p role="alert" className={cn("mt-2 text-xs", error.rejected ? "text-muted-foreground" : "text-negative")}>
          {error.rejected ? t("wallet.rejected") : t("wallet.signFailed", { message: error.message })}
          {!error.rejected && needsSponsor ? ` ${t("wallet.noGas", { chain: network.chainLabel })}` : null}
        </p>
      ) : null}
    </div>
  );
}
