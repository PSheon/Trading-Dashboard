"use client";

import { createContext, use, useMemo, useState } from "react";

import { DepositDialog } from "./deposit-dialog";
import { ExportKeyDialog } from "./export-key-dialog";
import { WithdrawDialog } from "./withdraw-dialog";

type WalletModal = "deposit" | "withdraw" | "export" | null;

interface WalletModals {
  openDeposit: () => void;
  openWithdraw: () => void;
  openExport: () => void;
}

const noop = () => {};
const Context = createContext<WalletModals>({ openDeposit: noop, openWithdraw: noop, openExport: noop });

/** Opens the 儲值 / 提款 / 匯出私鑰 modals from anywhere (header pill,
 * portfolio, settings). One instance of each, mounted by the app shell. */
export function useWalletModals(): WalletModals {
  return use(Context);
}

export function WalletModalsProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState<WalletModal>(null);
  const value = useMemo<WalletModals>(
    () => ({
      openDeposit: () => setOpen("deposit"),
      openWithdraw: () => setOpen("withdraw"),
      openExport: () => setOpen("export"),
    }),
    [],
  );
  const close = (next: boolean) => {
    if (!next) setOpen(null);
  };
  return (
    <Context value={value}>
      {children}
      <DepositDialog open={open === "deposit"} onOpenChange={close} />
      <WithdrawDialog open={open === "withdraw"} onOpenChange={close} />
      <ExportKeyDialog open={open === "export"} onOpenChange={(next) => setOpen(next ? "export" : null)} />
    </Context>
  );
}
