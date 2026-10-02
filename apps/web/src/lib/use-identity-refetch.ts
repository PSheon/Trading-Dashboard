"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { takeAnonymousReads } from "@/lib/api";
import type { AuthStatus } from "@/lib/auth";

/**
 * Public reads don't wait for the identity provider (lib/api.ts): with a
 * saved session they go out before the token exists, and their answers
 * lack the caller's own fields (a trader's favorite flag). Once the
 * provider reports a signed-in visitor, every query is refetched once, in
 * the background: loaded data stays on screen and requests still in flight
 * are restarted with the token. A visitor who turns out to be signed out
 * needs nothing.
 */
export function useIdentityRefetch(status: AuthStatus): void {
  const queryClient = useQueryClient();
  const previous = useRef(status);
  useEffect(() => {
    const was = previous.current;
    previous.current = status;
    if (was !== "loading" || status === "loading") return;
    if (takeAnonymousReads() && status === "signedIn") void queryClient.invalidateQueries();
  }, [status, queryClient]);
}
