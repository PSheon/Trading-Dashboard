"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { TradeShareDialog, type TradeCardSource } from "./trade-share-dialog";

const TraderShareContext = createContext<((source: TradeCardSource) => void) | null>(null);

/** The address-keyed page owns sharing while its responsive tables remount. */
export function TraderShareFlow({ children }: { children: ReactNode }) {
  const [source, setSource] = useState<TradeCardSource | null>(null);
  return <TraderShareContext.Provider value={setSource}>
    {children}
    {source ? <TradeShareDialog source={source} onClose={() => setSource(null)} /> : null}
  </TraderShareContext.Provider>;
}

/** Standalone tables and design previews use the same sharing controller. */
export function TraderShareScope({ children }: { children: ReactNode }) {
  const shared = useContext(TraderShareContext);
  return shared ? <>{children}</> : <TraderShareFlow>{children}</TraderShareFlow>;
}

export function useTraderShareFlow() {
  const open = useContext(TraderShareContext);
  if (!open) throw new Error("Trader sharing requires a sharing scope");
  return open;
}
