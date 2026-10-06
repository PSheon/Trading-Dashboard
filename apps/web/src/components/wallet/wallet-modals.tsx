"use client";

import { createContext, use, useMemo, useState } from "react";

import { DepositDialog } from "./deposit-dialog";
import { ExportKeyDialog, type ExportTarget } from "./export-key-dialog";
import { WithdrawDialog } from "./withdraw-dialog";
import { IslandBoundary } from "@/components/island-boundary";

type WalletModal = "deposit" | "withdraw" | "export" | null;

interface WalletModals {
  openDeposit: () => void;
  openWithdraw: () => void;
  /** The main account's key, or one copy wallet's (`target`). */
  openExport: (target?: ExportTarget) => void;
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
  const [exportTarget, setExportTarget] = useState<ExportTarget | null>(null);
  const value = useMemo<WalletModals>(
    () => ({
      openDeposit: () => setOpen("deposit"),
      openWithdraw: () => setOpen("withdraw"),
      openExport: (target?: ExportTarget) => { setExportTarget(target ?? null); setOpen("export"); },
    }),
    [],
  );
  const close = (next: boolean) => {
    if (!next) setOpen(null);
  };
  return (
    <Context value={value}>
      {children}
      {/* A dialog that crashes takes only itself down; opening it again retries. */}
      <IslandBoundary resetKey={open}><DepositDialog open={open === "deposit"} onOpenChange={close} /></IslandBoundary>
      <IslandBoundary resetKey={open}><WithdrawDialog open={open === "withdraw"} onOpenChange={close} /></IslandBoundary>
      <IslandBoundary resetKey={open}><ExportKeyDialog open={open === "export"} target={exportTarget} onOpenChange={(next) => setOpen(next ? "export" : null)} /></IslandBoundary>
    </Context>
  );
}
