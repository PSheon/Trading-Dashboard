"use client";

import { queryKeys } from "@/lib/query-keys";
import type { Permission } from "@trading-dashboard/shared/contracts";
import { hasPermission } from "@/lib/permissions";
import { PrivyProvider, usePrivy } from "@privy-io/react-auth";
import { useQuery } from "@tanstack/react-query";
import type { MeResponse } from "@/lib/contracts";
import { createContext, use, useCallback, useEffect, useMemo, useRef } from "react";

import { SessionQueries } from "@/lib/session-queries";
import { APP_NAME, PRIVY_APP_ID } from "@/lib/config";
import { api, sessionKey, setAccessTokenGetter } from "@/lib/api";
import { useI18n } from "@/i18n/provider";
import { readLocalStorage, useLocalStorage } from "@/lib/use-local-storage";

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
}

const noop = () => {};
const AuthContext = createContext<AuthState>({
  status: "disabled",
  mode: "none",
  login: noop,
  logout: async () => {},
  identity: null,
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

function PrivyBridge({ children }: { children: React.ReactNode }) {
  const { ready, authenticated, login, logout, getAccessToken, user } = usePrivy();

  // Registered during render (idempotent) rather than in an effect: child
  // queries subscribe in their own effects, which run before ours, and the
  // first /me request must already carry the token.
  // Until Privy is ready, a browser with a saved Privy session makes its
  // requests wait for the token; one without goes ahead as anonymous at once.
  const scope = ready
    ? authenticated && user?.id ? user.id : "anonymous"
    : hasSavedPrivySession() ? "loading" : "anonymous";
  setAccessTokenGetter(getAccessToken, scope);

  const value = useMemo<AuthState>(
    () => ({
      status: !ready ? "loading" : authenticated ? "signedIn" : "signedOut",
      mode: "privy",
      login: () => login(),
      logout: () => logout(),
      identity: user?.email?.address ?? user?.wallet?.address ?? null,
    }),
    [ready, authenticated, login, logout, user],
  );

  return <AuthContext value={value}><SessionQueries key={sessionKey()}>{children}</SessionQueries></AuthContext>;
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
    }),
    [signedIn, persist],
  );

  return <AuthContext value={value}><SessionQueries key={sessionKey()}>{children}</SessionQueries></AuthContext>;
}

// --- side effects shared by every mode ------------------------------------------

/** The keyed session boundary resets state on identity changes. Adopt the saved locale. */
function AuthEffects() {
  const { data: me } = useMe();
  const { locale, setLocale } = useI18n();
  const adoptedFor = useRef<number | null>(null);

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
      <PrivyProvider
        appId={PRIVY_APP_ID}
        config={{
          // Login methods come from the Privy dashboard, not from here.
          appearance: {
            // Orbie navy panel and orange accent (Stage 2 §9).
            theme: "#17142b",
            accentColor: "#ff7a45",
            landingHeader: APP_NAME,
          },
        }}
      >
        <PrivyBridge>
          <AuthEffects />
          {children}
        </PrivyBridge>
      </PrivyProvider>
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
