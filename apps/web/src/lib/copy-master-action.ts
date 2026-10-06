import { copyMasterActionRequestSchema, sameMasterTypedData, type CopyMasterActionKind, type CopyMasterActionRequest } from "@trading-dashboard/shared/contracts";
import type { Eip712TypedData, WalletSigner } from "./wallet-signer";

/**
 * The copy account's own signature of one action Orbie prepared for it
 * (account mode, agent approval, builder fee, a return to the main wallet).
 * The copy account is a Privy wallet the owner alone owns, so it signs here,
 * in the owner's browser, silently: the server can't sign with the owner's
 * session for this Privy app. The request is checked first: it is for the
 * expected kind and copy account, still current and, when the caller knows
 * the exact payload (it derived it from the consent it signs), that payload.
 */
export async function signMasterAction(wallet: Pick<WalletSigner, "signAsAccount">, raw: unknown,
  expected: { kind: CopyMasterActionKind; account: string; typedData?: unknown }, now = Date.now()): Promise<`0x${string}`> {
  const request: CopyMasterActionRequest = copyMasterActionRequestSchema.parse(raw);
  if (request.kind !== expected.kind || request.account !== expected.account.toLowerCase() ||
    (expected.typedData !== undefined && !sameMasterTypedData(request, expected.typedData))) throw new Error("master_action_changed");
  if (request.expiresAt <= now) throw new Error("master_action_expired");
  return wallet.signAsAccount(request.account, request.typedData as unknown as Eip712TypedData);
}

/** The calm, specific code the UI names for a copy-account signing error. */
export type MasterActionErrorCode = "copy_wallet_unavailable" | "wallet_not_ready" | "signature_rejected" | "master_action_changed" | "wallet_signing_failed";
export function masterActionErrorCode(error: unknown): MasterActionErrorCode {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (message === "copy_wallet_unavailable" || message === "master_action_changed") return message;
  if (message === "master_action_expired") return "master_action_changed";
  if (/not ready|sign in again|owner_wallet_unavailable/i.test(message)) return "wallet_not_ready";
  if (/reject|denied|cancel|exited|closed/i.test(message)) return "signature_rejected";
  return "wallet_signing_failed";
}
