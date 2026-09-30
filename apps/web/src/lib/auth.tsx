"use client";

import { queryKeys } from "@/lib/query-keys";
import type { Permission } from "@trading-dashboard/shared/contracts";
import { hasPermission } from "@/lib/permissions";
import {
  PrivyProvider,
  useCreateWallet,
  useExportWallet,
  usePrivy,
  useSendTransaction,
  useSignTypedData,
  useWallets,
} from "@privy-io/react-auth";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { MeResponse } from "@/lib/contracts";
import { createContext, use, useCallback, useEffect, useMemo, useRef } from "react";

import { Lockup } from "@/components/brand/logo";
import { ARBITRUM_CHAINS } from "@/lib/hyperliquid-network";
import type { WalletSigner } from "@/lib/wallet-signer";

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

function PrivyBridge({ children }: { children: React.ReactNode }) {
  const { ready, authenticated, login, logout, getAccessToken, user } = usePrivy();
  const wallet = useEmbeddedWallet(ready && authenticated);

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
      wallet,
    }),
    [ready, authenticated, login, logout, user, wallet],
  );

  return <AuthContext value={value}><SessionQueries key={sessionKey()}>{children}</SessionQueries></AuthContext>;
}

/**
 * The signed-in user's Privy embedded wallet: their Orbie main account and
 * Hyperliquid address. New users get one at login (`createOnLogin`); a user
 * who signed up before that setting existed gets one here, once, on their
 * next visit. The api learns the address from Privy itself (GET /me/wallet),
 * never from this page.
 */
function useEmbeddedWallet(signedIn: boolean): WalletSigner | null {
  const { wallets, ready } = useWallets();
  const { exportWallet } = useExportWallet();
  const { signTypedData } = useSignTypedData();
  const { sendTransaction } = useSendTransaction();
  const { createWallet } = useCreateWallet();
  const queryClient = useQueryClient();
  const creating = useRef(false);
  const embedded = wallets.find((w) => w.walletClientType === "privy") ?? null;

  useEffect(() => {
    if (!signedIn || !ready || embedded || creating.current) return;
    creating.current = true;
    createWallet()
      .then(() => queryClient.invalidateQueries({ queryKey: queryKeys.wallet.all }))
      .catch(() => {
        // Already has one (created in another tab) or Privy refused: the
        // wallet panel shows "not ready" and a reload tries again.
      });
  }, [signedIn, ready, embedded, createWallet, queryClient]);

  const address = embedded?.address ?? null;
  return useMemo<WalletSigner | null>(() => {
    if (!signedIn) return null;
    const target = address ? { address } : undefined;
    return {
      address,
      exportKey: () => exportWallet(target),
      signTypedData: async (data) => {
        const { signature } = await signTypedData(data, target);
        return signature as `0x${string}`;
      },
      sendTransaction: async (tx, sponsor) => {
        const { hash } = await sendTransaction(tx, { sponsor, ...target });
        return hash;
      },
    };
  }, [signedIn, address, exportWallet, signTypedData, sendTransaction]);
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
            // Orbie navy panel and orange accent (Stage 2 §9). The logo is
            // rendered in this document, so the wordmark keeps its Fredoka
            // face; the title stays Privy's "Log in or sign up", as on CopyDog.
            theme: "#17142b",
            accentColor: "#ff7a45",
            logo: <Lockup markSize={34} />,
          },
          // Every user gets an embedded wallet: their main account.
          embeddedWallets: { ethereum: { createOnLogin: "all-users" } },
          // Deposits bridge from Arbitrum (Arbitrum Sepolia on testnet).
          supportedChains: [...ARBITRUM_CHAINS],
          defaultChain: ARBITRUM_CHAINS[0],
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
