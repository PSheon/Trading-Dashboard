"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { createSessionQueryClient } from "./session-query-client";

/** Key this boundary by stable identity: queries, mutations and local UI state
 * must never survive a sign-in, sign-out or direct account switch. */
export function SessionQueries({ children }: { children?: React.ReactNode }) {
  const [client] = useState(createSessionQueryClient);
  useEffect(() => () => { client.clear(); }, [client]);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
