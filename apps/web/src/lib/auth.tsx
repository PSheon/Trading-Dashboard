"use client";

import { queryKeys } from "@/lib/query-keys";
import type { Permission } from "@trading-dashboard/shared/contracts";
import { hasPermission } from "@/lib/permissions";
import { useQuery } from "@tanstack/react-query";
import type { MeResponse } from "@/lib/contracts";
import { createContext, lazy, Suspense, use, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import type { PrivySnapshot } from "@/lib/auth-privy";
import type { WalletSigner } from "@/lib/wallet-signer";

import { SessionQueries } from "@/lib/session-queries";
import { PRIVY_APP_ID } from "@/lib/config";
import { api, sessionKey, setAccessTokenGetter } from "@/lib/api";
import { useI18n } from "@/i18n/provider";
import { readLocalStorage, useLocalStorage } from "@/lib/use-local-storage";
import { useIdentityRefetch } from "@/lib/use-identity-refetch";
import { useWalletBackfill } from "@/lib/use-wallet-backfill";

/**
 * One auth surface for the whole app, whatever is behind it:
 * - Privy, when NEXT_PUBLIC_PRIVY_APP_ID is set (the real thing);
 * - a fixture login in NEXT_PUBLIC_API_FIXTURES mode without Privy, so the
 *   signed-in pages can be built and screenshotted;
 * - otherwise "disabled": the login button is greyed out and everything
 *   public still works.
 * Components only use `useAuth()` / `useMe()`, never Privy directly.
 */
export type AuthStatus = "disabled" | "loading" | "signedOut" | "signedIn";

export interface AuthState {
  status: AuthStatus;
  mode: "privy" | "fixture" | "none";
  login: () => void;
  logout: () => Promise<void>;
  /** Email or wallet from the identity provider, before /me loads. */
  identity: string | null;
  /** The identity provider's user id (Privy's DID) when signed in. */
  userId?: string | null;
  /** The user's own embedded wallet (Privy mode only); null otherwise. */
  wallet: WalletSigner | null;
}

const noop = () => {};
const AuthContext = createContext<AuthState>({
  status: "disabled",
  mode: "none",
  login: noop,
  logout: async () => {},
  identity: null,
  wallet: null,
});

export function useAuth(): AuthState {
  return use(AuthContext);
}

/** GET /me — the signed-in user (role, locale). Undefined when signed out. */
export function useMe() {
  const { status } = useAuth();
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: ({ signal }) => api.get<MeResponse>("/me", signal),
    enabled: status === "signedIn",
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}

export function usePermission(permission: Permission): boolean {
  const { status } = useAuth();
  const me = useMe();
  return status === "signedIn" && !me.isError && hasPermission(me.data, permission);
}

export function useIsAdmin(): boolean {
  return usePermission("admin.access");
}

// --- Privy ------------------------------------------------------------------

/** The SDK, loaded on demand (see lib/auth-privy.tsx). */
const PrivyRuntime = lazy(() => import("@/lib/auth-privy"));

/** Privy's Google / Apple login returns here with these in the URL; Privy
 * must load at once to finish the sign-in. */
function hasPrivyCallback(): boolean {
  try {
    return new URLSearchParams(window.location.search).has("privy_oauth_code");
  } catch {
    return false;
  }
}

const noSubscription = () => () => {};

/** When to load the SDK on a page whose visitor has no saved session: once
 * the browser is idle, and at the latest after this long. */
const PRIVY_IDLE_TIMEOUT_MS = 3_000;

function PrivyAuth({ appId, children }: { appId: string; children: React.ReactNode }) {
  const [privy, setPrivy] = useState<PrivySnapshot | null>(null);
  // Whether Privy is needed at once (a saved session, or Privy's OAuth
  // callback in the URL); null on the server and while hydrating, so the
  // server's frame and the first client frame agree ("loading").
  const urgent = useSyncExternalStore(noSubscription, () => hasSavedPrivySession() || hasPrivyCallback(), () => null);
  const [requested, setRequested] = useState(false);
  const loginWhenReady = useRef(false);
  const load = urgent === true || requested;

  useEffect(() => {
    if (urgent !== false) return;
    const now = () => setRequested(true);
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(now, { timeout: PRIVY_IDLE_TIMEOUT_MS });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(now, PRIVY_IDLE_TIMEOUT_MS);
    return () => window.clearTimeout(id);
  }, [urgent]);

  // 登入 pressed before the SDK arrived: open Privy's modal once it is ready.
  useEffect(() => {
    if (!privy?.ready || !loginWhenReady.current) return;
    loginWhenReady.current = false;
    if (!privy.authenticated) privy.login();
  }, [privy]);

  // Registered during render (idempotent) rather than in an effect: child
  // queries subscribe in their own effects, which run before ours, and the
  // first /me request must already carry the token.
  // Until Privy is ready, a browser with a saved Privy session makes the
  // requests that need the caller wait for the token (public reads go out
  // at once, see lib/api.ts); one without goes ahead as anonymous at once.
  const scope = privy?.ready
    ? privy.authenticated && privy.userId ? privy.userId : "anonymous"
    : urgent !== false ? "loading" : "anonymous";
  setAccessTokenGetter(privy?.getAccessToken ?? null, scope);

  const status: AuthStatus = privy?.ready
    ? privy.authenticated ? "signedIn" : "signedOut"
    : urgent !== false ? "loading" : "signedOut";
  const login = useCallback(() => {
    if (privy?.ready) { privy.login(); return; }
    loginWhenReady.current = true;
    setRequested(true);
  }, [privy]);
  const value = useMemo<AuthState>(
    () => ({
      status,
      mode: "privy",
      login,
      logout: () => privy?.logout() ?? Promise.resolve(),
      identity: privy?.ready && privy.authenticated ? privy.identity : null,
      userId: privy?.ready && privy.authenticated ? privy.userId : null,
      wallet: privy?.ready && privy.authenticated ? privy.wallet : null,
    }),
    [status, login, privy],
  );

  return (
    <>
      {load ? <Suspense fallback={null}><PrivyRuntime appId={appId} onChange={setPrivy} /></Suspense> : null}
      <AuthContext value={value}><SessionQueries key={sessionKey()}>{children}</SessionQueries></AuthContext>
    </>
  );
}

function hasSavedPrivySession(): boolean {
  return readLocalStorage("privy:token") !== null || readLocalStorage("privy:refresh_token") !== null;
}

// --- fixture login ------------------------------------------------------------

const FIXTURE_SESSION_KEY = "fixture-signed-in";

const fixtureTokenGetter = async () =>
  readLocalStorage(FIXTURE_SESSION_KEY) === "1" ? "fixture-token" : null;

function FixtureAuth({ children }: { children: React.ReactNode }) {
  // undefined while hydrating, so server and client render the same frame.
  const [stored, setStored] = useLocalStorage(FIXTURE_SESSION_KEY);
  const signedIn = stored === undefined ? null : stored === "1";

  const scope = signedIn ? "fixture:demo" : signedIn === null ? "loading" : "anonymous";
  setAccessTokenGetter(fixtureTokenGetter, scope);

  const persist = useCallback((next: boolean) => setStored(next ? "1" : null), [setStored]);

  const value = useMemo<AuthState>(
    () => ({
      status: signedIn === null ? "loading" : signedIn ? "signedIn" : "signedOut",
      mode: "fixture",
      login: () => persist(true),
      logout: async () => persist(false),
      identity: signedIn ? "demo@example.com" : null,
      wallet: null,
    }),
    [signedIn, persist],
  );

  return <AuthContext value={value}><SessionQueries key={sessionKey()}>{children}</SessionQueries></AuthContext>;
}

// --- side effects shared by every mode ------------------------------------------

/** The keyed session boundary resets state on identity changes. Adopt the
 * saved locale; have the api store a freshly created embedded wallet;
 * refetch what was read before the visitor was known. */
function AuthEffects() {
  const { data: me } = useMe();
  const { wallet, status } = useAuth();
  useIdentityRefetch(status);
  const { locale, setLocale } = useI18n();
  const adoptedFor = useRef<number | null>(null);
  useWalletBackfill(wallet?.address ?? null);

  useEffect(() => {
    if (!me || adoptedFor.current === me.id) return;
    adoptedFor.current = me.id;
    if (me.locale !== locale) setLocale(me.locale);
  }, [me, locale, setLocale]);

  return null;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  if (PRIVY_APP_ID) {
    return (
      <PrivyAuth appId={PRIVY_APP_ID}>
        <AuthEffects />
        {children}
      </PrivyAuth>
    );
  }

  if (process.env.NEXT_PUBLIC_API_FIXTURES === "1") {
    return (
      <FixtureAuth>
        <AuthEffects />
        {children}
      </FixtureAuth>
    );
  }

  setAccessTokenGetter(null);
  return <SessionQueries>{children}</SessionQueries>;
}
