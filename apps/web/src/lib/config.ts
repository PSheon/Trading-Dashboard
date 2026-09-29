/**
 * Public (NEXT_PUBLIC_*) settings, inlined at build time. Nothing secret
 * belongs here: the Privy app id is public by design.
 */

/** Product name shown in the UI, page titles and the wordmark (Stage 2 §9). */
export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME?.trim() || "Orbie";

/** Canonical origin, for metadataBase / Open Graph URLs. */
export const APP_URL = process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://app.orbie.fun";

/** Privy app id. Unset → the login button is disabled and the app runs
 * anonymously. */
export const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim() || "";

/** `NEXT_PUBLIC_API_FIXTURES=1` answers api calls from src/fixtures instead
 * of apps/api (for UI work before the Stage 2 endpoints exist). Off unless
 * the variable is set at build time. */
export const API_FIXTURES = process.env.NEXT_PUBLIC_API_FIXTURES === "1";
