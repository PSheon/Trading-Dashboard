"use client";

/**
 * Privy itself: the SDK, its provider and the user's embedded wallet. Only
 * lib/auth.tsx loads this module, lazily (React.lazy), so the SDK is not
 * part of any page's first JavaScript: a public page loads it when the
 * browser is idle, at once when a Privy session is saved or Privy's OAuth
 * callback is in the URL, or when the visitor presses 登入.
 *
 * Privy's provider is not an ancestor of the page: it renders beside it
 * (its modals portal to the body) and reports its state upward
 * (`onChange`), so the page tree stays the same whether Privy has loaded
 * or not. Components never use Privy directly, only `useAuth()`.
 */
import { isPrivyWallet, primaryEmbeddedWalletAddress } from "@trading-dashboard/shared/contracts";
import {
  PrivyProvider,
  useCreateWallet,
  useExportWallet,
  usePrivy,
  useSendTransaction,
  useSignTypedData,
  useWallets,
} from "@privy-io/react-auth";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";

import { ARBITRUM_CHAINS } from "@/lib/hyperliquid-network";
import type { WalletSigner } from "@/lib/wallet-signer";
import { useTheme } from "./use-theme";

/** What lib/auth.tsx needs from Privy. */
export interface PrivySnapshot {
  ready: boolean;
  authenticated: boolean;
  userId: string | null;
  identity: string | null;
  login: () => void;
  logout: () => Promise<void>;
  getAccessToken: () => Promise<string | null>;
  wallet: WalletSigner | null;
}

export default function PrivyRuntime({ appId, onChange }: { appId: string; onChange: (snapshot: PrivySnapshot | null) => void }) {
  // The sign-in modal follows the theme on screen.
  const { theme } = useTheme();
  return (
    <PrivyProvider
      appId={appId}
      config={{
        // Login methods come from the Privy dashboard, not from here.
        appearance: {
          // Orbit's card colours and orange accent. The logo is the lockup
          // exported from docs/Orbie Logo.html (Fredoka 600 wordmark baked
          // in; Privy didn't render a React element there), in cream on
          // the dark card and ink on the light one. No landingHeader: the
          // title stays Privy's "Log in or sign up", as on CopyDog.
          theme: theme === "dark" ? "#2a2655" : "#ffffff",
          accentColor: "#ff7a45",
          logo: theme === "dark" ? "/orbie-lockup.png" : "/orbie-lockup-ink.png",
        },
        // Every user gets an embedded wallet: their main account.
        embeddedWallets: { ethereum: { createOnLogin: "all-users" } },
        // Deposits bridge from Arbitrum (Arbitrum Sepolia on testnet).
        supportedChains: [...ARBITRUM_CHAINS],
        defaultChain: ARBITRUM_CHAINS[0],
      }}
    >
      <PrivyReporter onChange={onChange} />
    </PrivyProvider>
  );
}

/** Reports a new snapshot only when what it says changes (Privy's hooks
 * hand out new functions and objects on every render, and each report
 * re-renders the page and so this component). */
function PrivyReporter({ onChange }: { onChange: (snapshot: PrivySnapshot | null) => void }) {
  const { ready, authenticated, login, logout, getAccessToken, user } = usePrivy();
  const wallet = useEmbeddedWallet(ready && authenticated);
  const calls = useRef({ login, logout, getAccessToken });
  useLayoutEffect(() => { calls.current = { login, logout, getAccessToken }; });
  const userId = user?.id ?? null;
  const identity = user?.email?.address ?? user?.google?.email ?? user?.apple?.email ?? user?.wallet?.address ?? null;
  const snapshot = useMemo<PrivySnapshot>(() => ({
    ready,
    authenticated,
    userId,
    identity,
    login: () => calls.current.login(),
    logout: () => calls.current.logout(),
    getAccessToken: () => calls.current.getAccessToken(),
    wallet,
  }), [ready, authenticated, userId, identity, wallet]);
  useLayoutEffect(() => { onChange(snapshot); }, [snapshot, onChange]);
  useLayoutEffect(() => () => onChange(null), [onChange]);
  return null;
}

/**
 * The signed-in user's Privy embedded wallet: their Orbie main account and
 * Hyperliquid address. New users get one at login (`createOnLogin`); a user
 * who signed up before that setting existed gets one here, once, on their
 * next visit. The api learns the address from Privy itself (GET /me/wallet),
 * never from this page.
 */
function useEmbeddedWallet(signedIn: boolean): WalletSigner | null {
  const { user } = usePrivy();
  const { wallets, ready } = useWallets();
  const { exportWallet } = useExportWallet();
  const { signTypedData } = useSignTypedData();
  const { sendTransaction } = useSendTransaction();
  const { createWallet } = useCreateWallet();
  const creatingFor = useRef<string | null>(null);
  const activeSigner = useRef<WalletSigner | null>(null);
  const userId = signedIn ? user?.id ?? null : null;
  const linkedWallets = user?.linkedAccounts.filter((account) => account.type === "wallet").map((account) => ({
    address: account.address,
    chainType: account.chainType,
    clientType: account.walletClientType ?? "",
    index: account.walletIndex,
    imported: account.imported,
  })) ?? [];
  const primary = primaryEmbeddedWalletAddress(linkedWallets);
  const embedded = ready && userId && primary ? wallets.find((wallet) => isPrivyWallet(wallet.walletClientType) && wallet.address.toLowerCase() === primary) : null;
  const hasEmbedded = linkedWallets.some((wallet) => isPrivyWallet(wallet.clientType) && wallet.chainType === "ethereum") || wallets.some((wallet) => isPrivyWallet(wallet.walletClientType));

  useEffect(() => {
    if (!signedIn) { creatingFor.current = null; return; }
    if (!userId || !ready || hasEmbedded || creatingFor.current === userId) return;
    creatingFor.current = userId;
    // No query invalidation here: this runs above the session QueryClient.
    // The pages show the new address from Privy at once (useWalletAddress);
    // AuthEffects (useWalletBackfill) refetches /me and /me/wallet when the
    // address appears so the api stores it.
    createWallet().catch(() => {
        // Already has one (created in another tab) or Privy refused: the
        // wallet panel shows "not ready" and a reload tries again.
      });
  }, [signedIn, userId, ready, hasEmbedded, createWallet]);

  const address = embedded?.address.toLowerCase() ?? null;
  // The SDK's functions, read at call time: Privy may hand out new ones on
  // every render, and a new signer each render would report again.
  const sdk = useRef({ exportWallet, signTypedData, sendTransaction });
  useLayoutEffect(() => { sdk.current = { exportWallet, signTypedData, sendTransaction }; });
  const signer = useMemo<WalletSigner | null>(() => {
    if (!signedIn) return null;
    const { exportWallet, signTypedData, sendTransaction } = {
      exportWallet: (...args: Parameters<typeof sdk.current.exportWallet>) => sdk.current.exportWallet(...args),
      signTypedData: (...args: Parameters<typeof sdk.current.signTypedData>) => sdk.current.signTypedData(...args),
      sendTransaction: (...args: Parameters<typeof sdk.current.sendTransaction>) => sdk.current.sendTransaction(...args),
    };
    const assertActive = () => {
      if (!address || !userId || activeSigner.current !== current) throw new Error("Wallet is not ready. Reload or sign in again.");
      // Never allow the SDK to fall back to a default wallet.
      return { address };
    };
    const current: WalletSigner = {
      address,
      exportKey: async () => { await exportWallet(assertActive()); },
      exportCopyKey: async (target) => {
        assertActive();
        if (!/^0x[0-9a-fA-F]{40}$/.test(target)) throw new Error("Not a wallet address");
        await exportWallet({ address: target.toLowerCase() });
      },
      signTypedData: async (data) => {
        const { signature } = await signTypedData(data, assertActive());
        return signature as `0x${string}`;
      },
      sendTransaction: async (tx, sponsor) => {
        const { hash } = await sendTransaction(tx, { sponsor, ...assertActive() });
        return hash;
      },
    };
    return current;
  }, [signedIn, userId, address]);

  useEffect(() => {
    activeSigner.current = signer;
    return () => { activeSigner.current = null; };
  }, [signer]);
  return signer;
}
