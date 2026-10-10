"use client";

import { createContext, useContext, type ReactNode } from "react";
import { useLiveCopySetupActions } from "@/lib/copy-live-setup";

type LiveCopyActions = ReturnType<typeof useLiveCopySetupActions>;
const TraderCopyFlowContext = createContext<LiveCopyActions | null>(null);

export function TraderCopyFlow({ children }: { children: ReactNode }) {
  // The page owns the operation. Responsive panels may be replaced while
  // a request or signature is pending; owner and page unmount guards remain
  // in useLiveCopySetupActions, and the route keys this boundary by trader.
  const actions = useLiveCopySetupActions();
  return <TraderCopyFlowContext.Provider value={actions}>{children}</TraderCopyFlowContext.Provider>;
}

export function useTraderCopyFlow(): LiveCopyActions | null {
  return useContext(TraderCopyFlowContext);
}
