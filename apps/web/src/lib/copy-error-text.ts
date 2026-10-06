import type { CopyErrorText } from "@/i18n/copy-errors";
import { fill, type LiveSetupText } from "@/i18n/live-setup";
import { ApiError, apiErrorCode } from "@/lib/api";
import { truncateAddress } from "@/lib/format";
import { signErrorMessage } from "@/lib/wallet";

/** Both catalogs a copy flow speaks from, in the page's language. */
export interface CopyTexts { live: LiveSetupText; extra: CopyErrorText }

/** Issues (and api codes) that mean "Hyperliquid or the api is busy right now". */
const BUSY_CODES = new Set(["busy", "hyperliquid_busy", "bad_gateway", "deadline_exceeded", "hyperliquid_quota_exhausted"]);
/** Client-side throws of the copy flows, by their message. */
const CLIENT_CODES: Record<string, string> = {
  owner_wallet_unavailable: "owner_wallet_unavailable", live_session_changed: "live_session_changed", setup_consent_expired: "consent_expired",
  signing_timeout: "signing_timeout", "Wallet is not ready. Reload or sign in again.": "wallet_not_ready",
};

/**
 * A failure that passes on its own: Hyperliquid busy, a 502/503/504 from the
 * api or its forwarder, or the network. A flow says these calmly and tries
 * again; it never turns one into 「發生錯誤」.
 */
export function isTransient(error: unknown): boolean {
  if (error instanceof ApiError) return error.status === 502 || error.status === 503 || error.status === 504 || BUSY_CODES.has(error.code ?? "");
  if (error instanceof Error && error.name === "AbortError") return false;
  // fetch's own failure (offline, reset): TypeError "Failed to fetch" / "Load failed" / "NetworkError…".
  return error instanceof TypeError && /fetch|network|load failed/i.test(error.message);
}

/** When to ask again after `error`: the api's Retry-After (bounded), else `fallback`. */
export function retryAfter(error: unknown, fallback: number): number {
  const hint = error instanceof ApiError ? error.retryAfterMs : undefined;
  return typeof hint === "number" && Number.isFinite(hint) && hint > 0 ? Math.min(65_000, Math.max(1_000, hint)) : fallback;
}

/** The code a copy flow's error carries: the api's, else a known client throw. */
export function copyErrorCode(error: unknown): string | null {
  const code = apiErrorCode(error);
  if (code) return code;
  if (error instanceof Error && error.message in CLIENT_CODES) return CLIENT_CODES[error.message]!;
  return null;
}

/** The words for a code (an api code or a setup's issue), or null when it has none of its own. */
export function copyCodeText(texts: CopyTexts, code: string | null | undefined): string | null {
  if (!code) return null;
  if (code in texts.live.errors) return texts.live.errors[code as keyof LiveSetupText["errors"]];
  if (code in texts.extra.codes) return texts.extra.codes[code as keyof CopyErrorText["codes"]];
  if (code === "signing_timeout") return texts.extra.signingTimeout;
  if (BUSY_CODES.has(code)) return texts.extra.busy;
  return null;
}

/**
 * The one sentence every copy flow shows for a failure: the code's own
 * text, a refused signature, busy (502/503/504, Hyperliquid, the network),
 * rate limited (429), signed out (401), else the generic line. Never a raw
 * code or English status word.
 */
export function copyErrorText(texts: CopyTexts, error: unknown): string {
  const code = copyErrorCode(error);
  if (code === "strategy_limit" && error instanceof ApiError) {
    const limit = String(error.details.limit ?? "");
    const unfinished = Array.isArray(error.details.unfinished) ? error.details.unfinished as Array<{ leaderAddress?: unknown }> : [];
    const leader = unfinished.find((item) => typeof item.leaderAddress === "string")?.leaderAddress as string | undefined;
    return leader ? fill(texts.extra.strategyLimitUnfinished, { limit, trader: truncateAddress(leader) }) : fill(texts.extra.strategyLimit, { limit });
  }
  const own = copyCodeText(texts, code);
  if (own) return own;
  if (!(error instanceof ApiError) && signErrorMessage(error).rejected) return texts.live.errors.signature_rejected;
  if (isTransient(error)) return texts.extra.busy;
  if (error instanceof ApiError && error.status === 429) return texts.extra.rateLimited;
  if (error instanceof ApiError && (error.status === 401 || code === "authentication_required")) return texts.extra.signInAgain;
  return texts.live.errors.generic;
}
