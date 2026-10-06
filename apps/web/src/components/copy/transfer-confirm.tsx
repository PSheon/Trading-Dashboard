"use client";

import { TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/dialog";
import { useI18n } from "@/i18n/provider";
import { liveCopiesMessages } from "@/i18n/live-copies";
import { liveSetupText } from "@/i18n/live-setup";
import { truncateAddress } from "@/lib/format";

export type TransferSheetKind = "withdraw" | "returnAll" | "stop";

/**
 * The one confirm sheet in front of every movement of a testnet copy's
 * money: 提領閒置資金, 全部返還主錢包 and 申請停止 (whose funds come back
 * afterwards). It says the amount, where the money goes (your main wallet,
 * with its short address), the network and the expected time. It is the
 * same for every account: the worker signs the transfer under the account's
 * Privy policy, so no wallet prompt follows.
 */
export function TransferConfirm({ kind, open, amount, destination, network, pending, error, onConfirm, onOpenChange }: {
  kind: TransferSheetKind; open: boolean;
  /** The copy account's network: on mainnet the sheet says real funds (it said 測試網 there). */
  network: "testnet" | "mainnet" | null;
  /** The amount in words: "25.00 USDC", or 全部（約 …） for a return of everything. */
  amount: string | null;
  /** The owner's main wallet address, when known. */
  destination: string | null;
  pending: boolean; error: string | null;
  onConfirm: () => void; onOpenChange: (open: boolean) => void;
}) {
  const { locale, t } = useI18n(), ui = liveCopiesMessages[locale].ui;
  const title = kind === "withdraw" ? ui.withdrawTitle : kind === "returnAll" ? ui.returnTitle : ui.stopTitle;
  const wallet = destination ? `${ui.mainWallet} · ${truncateAddress(destination)}` : ui.mainWallet;
  const rows: [string, string][] = [[ui.amountRow, amount ?? "—"], [ui.destination, wallet], [ui.network, liveSetupText(locale, network).networkValue], [ui.eta, ui.etaValue]];
  const cta = kind === "stop" ? ui.confirmStop : kind === "withdraw" ? ui.confirmWithdraw : ui.confirmReturn;
  return (
    <Modal open={open} onOpenChange={(next) => { if (!pending) onOpenChange(next); }} title={title}>
      <div className="flex flex-col gap-4 px-6 pt-3 pb-6" data-testid="transfer-confirm" data-kind={kind}>
        {/* A stop is one plain sentence: what happens, and where the money goes. */}
        {kind === "stop" ? <p className="text-sm leading-6">{t("folio.stopSentence", { address: destination ? truncateAddress(destination) : "" }).replace("  ", " ")}</p> : (
          <dl className="divide-y divide-border rounded-2xl bg-inset px-4">
            {rows.map(([label, value]) => (
              <div key={label} className="flex items-start justify-between gap-4 py-2.5 text-sm">
                <dt className="shrink-0 text-muted-foreground">{label}</dt>
                <dd className="num min-w-0 text-right font-semibold break-words">{value}</dd>
              </div>
            ))}
          </dl>
        )}
        {error ? <p role="alert" className="flex items-start gap-2 rounded-xl bg-warning/10 px-3 py-2.5 text-xs leading-relaxed text-warning"><TriangleAlert className="mt-px size-3.5 shrink-0" />{error}</p> : null}
        <div className="flex flex-col gap-2.5">
          <Button type="button" size="cta" className="w-full" loading={pending} onClick={onConfirm}>{cta}</Button>
          <Button type="button" variant="ghost" className="w-full" disabled={pending} onClick={() => onOpenChange(false)}>{ui.cancel}</Button>
        </div>
      </div>
    </Modal>
  );
}
