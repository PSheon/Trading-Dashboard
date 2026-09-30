"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { createSessionQueryClient } from "./session-query-client";

/** Key this boundary by stable identity: queries, mutations and local UI state
 * must never survive a sign-in, sign-out or direct account switch. */
export function SessionQueries({ children }: { children?: React.ReactNode }) {
  const [client] = useState(createSessionQueryClient);
  // Cleared a tick after unmount, so React's dev-only unmount/remount check
  // doesn't wipe the cache and refetch every query.
  const retire = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    clearTimeout(retire.current);
    return () => { retire.current = setTimeout(() => client.clear()); };
  }, [client]);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
