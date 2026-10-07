"use client";

import { useCallback, useContext, useEffect, useSyncExternalStore } from "react";
import { QueryClientContext, type QueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { useLiveCopyDeployment } from "@/lib/copy-live-setup";

export type SiteMode = "paper" | "testnet" | "live";
const listeners = new Set<() => void>();
const memory = new Map<string, SiteMode>();
// A tab's query client owns its in-flight operations. All subscribers,
// including newly mounted panels, retain the same funds until they settle.
const retained = new WeakMap<QueryClient, Map<string, SiteMode>>();
function pinnedMode(client: QueryClient | undefined, key: string | null, next: SiteMode): SiteMode {
  if (!client || !key) return next;
  let modes = retained.get(client);
  if (!modes) { modes = new Map(); retained.set(client, modes); }
  const previous = modes.get(key);
  if (client.isMutating() && previous) return previous;
  modes.set(key, next);
  return next;
}
const valid = (value: string | null): value is SiteMode => value === "paper" || value === "testnet" || value === "live";
function read(key: string | null): SiteMode | null {
  if (!key) return null;
  try { const value = localStorage.getItem(key); return valid(value) ? value : null; }
  catch { return memory.get(key) ?? null; }
}
function save(key: string, mode: SiteMode) {
  memory.set(key, mode);
  try { localStorage.setItem(key, mode); } catch { /* Private windows retain the preference in memory. */ }
  listeners.forEach((listener) => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => { listeners.delete(listener); window.removeEventListener("storage", listener); };
}

/** User preference and server capability are separate: a missing capability
 * never silently changes the selected funds or execution network. */
export function useTradingMode() {
  const { identity } = useAuth();
  const client = useContext(QueryClientContext);
  const deployment = useLiveCopyDeployment();
  const key = identity ? `orbie:trading-mode:${identity}` : null;
  const subscribeScoped = useCallback((listener: () => void) => {
    const stop = subscribe(listener);
    const stopMutations = client?.getMutationCache().subscribe(listener);
    return () => { stop(); stopMutations?.(); };
  }, [client]);
  const pending = useSyncExternalStore(subscribeScoped, () => client?.isMutating() ?? 0, () => 0);
  const saved = read(key);
  // The old panel called ALL actual copies "testnet", including mainnet.
  const legacy = identity ? read(`orbie:copy-mode:${identity}`) : null;
  const migrated: SiteMode = legacy === "testnet" && deployment?.available
    ? deployment.network === "mainnet" ? "live" : "testnet" : "paper";
  const mode = useSyncExternalStore(subscribeScoped, () => pinnedMode(client, key, read(key) ?? migrated), () => "paper" as SiteMode);
  useEffect(() => {
    if (!pending && key && saved === null && legacy && (legacy === "paper" || deployment?.available)) save(key, migrated);
  }, [key, saved, legacy, migrated, deployment?.available, pending]);
  const network = deployment?.network, available = deployment?.available;
  const supports = useCallback((next: SiteMode) => next === "paper" || (available === true && network === (next === "live" ? "mainnet" : "testnet")), [available, network]);
  const select = useCallback((next: SiteMode) => {
    if (!key || client?.isMutating() || !supports(next)) return false;
    save(key, next);
    return true;
  }, [key, supports, client]);
  return { mode, pending, deploymentNetwork: network, available: supports(mode), supports, select };
}
export function useSiteMode(): SiteMode { return useTradingMode().mode; }
