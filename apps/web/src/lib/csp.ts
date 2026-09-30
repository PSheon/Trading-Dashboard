/**
 * The web app's Content-Security-Policy, set per request by `src/proxy.ts`
 * with a fresh nonce. Next.js reads the nonce from the request's CSP header
 * and puts it on its own scripts; with 'strict-dynamic' those may load the
 * rest (Privy's chunks, Cloudflare Turnstile), and nothing else runs.
 *
 * Origins the browser talks to, and why:
 * - 'self': pages, /_next assets, and our API through the same-origin
 *   forwarder (/api/hl/*, SSE included).
 * - Privy (docs.privy.io → Security → Content Security Policy): auth.privy.io
 *   (API and the embedded-wallet iframe), *.rpc.privy.systems, WalletConnect
 *   (relay, verify, explorer) and Coinbase's walletlink relay, and Cloudflare
 *   Turnstile (challenges.cloudflare.com). An app with a Privy custom auth
 *   domain (HttpOnly cookie sessions) loads its iframe and API from that
 *   domain instead: `privyAuthOrigins` (NEXT_PRIVY_AUTH_ORIGINS).
 * - Hyperliquid, mainnet and testnet: the trader page's live WebSocket, and
 *   the wallet's signed /exchange requests (stage4).
 * - Arbitrum One and Sepolia RPC: the chains Privy's embedded wallet sends
 *   deposits on (stage4 `ARBITRUM_CHAINS`).
 * - t.me: the Telegram bot link (navigation isn't governed by CSP; listed
 *   so a future fetch of it isn't a surprise).
 * Images may come from any https origin (coin icons, KOL avatars).
 */
export const CSP_CONNECT_ORIGINS = [
  "https://auth.privy.io",
  "wss://relay.walletconnect.com",
  "wss://relay.walletconnect.org",
  "wss://www.walletlink.org",
  "https://*.rpc.privy.systems",
  "https://explorer-api.walletconnect.com",
  "https://api.hyperliquid.xyz",
  "wss://api.hyperliquid.xyz",
  "https://api.hyperliquid-testnet.xyz",
  "wss://api.hyperliquid-testnet.xyz",
  "https://arb1.arbitrum.io",
  "https://sepolia-rollup.arbitrum.io",
  "https://t.me",
] as const;

export const CSP_FRAME_ORIGINS = [
  "https://auth.privy.io",
  "https://verify.walletconnect.com",
  "https://verify.walletconnect.org",
  "https://challenges.cloudflare.com",
] as const;

/** Privy custom auth domains of this project's Privy app (checked
 * 2026-09-30: the app serves its iframe and API from privy.stage.orbie.fun). */
export const DEFAULT_PRIVY_AUTH_ORIGINS = ["https://privy.orbie.fun", "https://privy.stage.orbie.fun"] as const;

/** The default Privy custom auth origins plus NEXT_PRIVY_AUTH_ORIGINS
 * (comma-separated https origins; anything else is ignored). */
export function privyAuthOrigins(extra: string | undefined): string[] {
  const listed = (extra ?? "").split(",").map((v) => v.trim()).filter(Boolean).flatMap((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.origin === value.replace(/\/$/, "") ? [url.origin] : [];
    } catch {
      return [];
    }
  });
  return [...new Set([...DEFAULT_PRIVY_AUTH_ORIGINS, ...listed])];
}

/** A fresh, unguessable nonce (128 random bits, base64). */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

export function contentSecurityPolicy({ nonce, dev, privyOrigins = [...DEFAULT_PRIVY_AUTH_ORIGINS] }: { nonce: string; dev: boolean; privyOrigins?: string[] }): string {
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    // React's dev build uses eval for error overlays; never in production.
    "script-src": ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", "https://challenges.cloudflare.com", ...(dev ? ["'unsafe-eval'"] : [])],
    // Style attributes (React, Privy's modal) need 'unsafe-inline'; a nonce
    // here would disable it. Scripts are what the policy locks down.
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:", "https:"],
    "font-src": ["'self'", "data:"],
    "connect-src": ["'self'", ...CSP_CONNECT_ORIGINS, ...privyOrigins],
    "frame-src": [...CSP_FRAME_ORIGINS, ...privyOrigins],
    "child-src": [...CSP_FRAME_ORIGINS, ...privyOrigins],
    "worker-src": ["'self'", "blob:"],
    "manifest-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
  };
  const policy = Object.entries(directives).map(([name, values]) => `${name} ${values.join(" ")}`);
  if (!dev) policy.push("upgrade-insecure-requests");
  return policy.join("; ");
}
