import { AppConfig } from "../../config/app-config.js";
import { Injectable, Logger } from "@nestjs/common";
import { PrivyClient, type LinkedAccount } from "@privy-io/node";
import { isPrivyWallet, primaryEmbeddedWalletAddress, type EmbeddedWalletIdentity } from "@trading-dashboard/shared/contracts";


/** A Privy access token that passed signature, issuer, audience and expiry
 * checks. */
export interface VerifiedPrivyToken {
  /** Privy DID, e.g. "did:privy:…". */
  privyUserId: string;
  expiresAt: Date;
}

/** What the api keeps from a Privy user on first login. */
export interface PrivyProfile {
  email: string | null;
  walletAddress: string | null;
  /** The Privy embedded Ethereum wallet: the user's Orbie main account.
   * Optional so stubs written before it keep compiling; absent = unknown. */
  embeddedWalletAddress?: string | null;
}

/**
 * The only thing the guard needs from Privy, behind an interface so tests
 * can stub it. `verifyAccessToken` throws on any invalid, expired or
 * foreign token, and when Privy isn't configured (fail closed).
 */
export interface PrivyVerifier {
  verifyAccessToken(accessToken: string): Promise<VerifiedPrivyToken>;
  /** Best effort; null when the profile can't be fetched. */
  fetchProfile(privyUserId: string): Promise<PrivyProfile | null>;
}

export const PRIVY_VERIFIER = Symbol("PRIVY_VERIFIER");

/** Picks the email and an Ethereum wallet from a Privy user's linked
 * accounts. The email is the email-login address, else the one from a
 * Google or Apple login (verified by that provider). An external
 * (self-custodied) wallet wins over the embedded one: it's the address the
 * person trades from. The embedded wallet is also returned on its own: it is
 * the main account the wallet pages use. */
export function profileFromLinkedAccounts(accounts: LinkedAccount[]): PrivyProfile {
  let email: string | null = null;
  let oauthEmail: string | null = null;
  let external: string | null = null;
  const embeddedWallets: EmbeddedWalletIdentity[] = [];
  for (const account of accounts) {
    if (account.type === "email" && !email) email = account.address;
    if ((account.type === "google_oauth" || account.type === "apple_oauth") && account.email) {
      oauthEmail ??= account.email;
    }
    if (account.type === "wallet" && "chain_type" in account && account.chain_type === "ethereum") {
      if (isPrivyWallet(account.wallet_client)) embeddedWallets.push({
        address: account.address,
        chainType: account.chain_type,
        clientType: account.wallet_client,
        index: "wallet_index" in account ? account.wallet_index : null,
        imported: "imported" in account ? account.imported : false,
      });
      else external ??= account.address;
    }
  }
  const embedded = primaryEmbeddedWalletAddress(embeddedWallets);
  const wallet = external ?? embedded;
  const chosen = email ?? oauthEmail;
  return {
    email: chosen?.toLowerCase() ?? null,
    walletAddress: wallet?.toLowerCase() ?? null,
    embeddedWalletAddress: embedded?.toLowerCase() ?? null,
  };
}

/**
 * `@privy-io/node` (0.35): `new PrivyClient({ appId, appSecret,
 * jwtVerificationKey? })`, `client.utils().auth().verifyAccessToken(token)`
 * → `{ user_id, app_id, session_id, issuer, issued_at, expiration }`, and
 * `client.users()._get(userId)` → `User` with `linked_accounts`. With
 * `PRIVY_VERIFICATION_KEY` set, verification is local (no network call);
 * without it the SDK fetches and caches the app's JWKS.
 */
/** Per Privy API call from the verifier (see the constructor). */
export const PRIVY_TIMEOUT_MS = 8_000;

@Injectable()
export class SdkPrivyVerifier implements PrivyVerifier {
  private readonly logger = new Logger(SdkPrivyVerifier.name);
  private readonly client: PrivyClient | null;

  constructor(private readonly config: AppConfig) {
    const appId = this.config.value.auth.appId;
    const appSecret = this.config.value.auth.appSecret;
    if (!appId || !appSecret) {
      this.logger.warn("PRIVY_APP_ID / PRIVY_APP_SECRET not set — Privy sign-in is disabled");
      this.client = null;
      return;
    }
    // The SDK's own default is a minute per call and two retries, far past
    // the request's 20 s deadline (which it never sees). The profile read
    // gets 8 s and one retry; the JWKS fetch behind token verification
    // (without PRIVY_VERIFICATION_KEY) is jose's, bounded at 5 s.
    this.client = new PrivyClient({
      appId,
      appSecret,
      jwtVerificationKey: this.config.value.auth.verificationKey,
      timeout: PRIVY_TIMEOUT_MS,
      maxRetries: 1,
    });
  }

  async verifyAccessToken(accessToken: string): Promise<VerifiedPrivyToken> {
    if (!this.client) throw new Error("Privy is not configured");
    const claims = await this.client.utils().auth().verifyAccessToken(accessToken);
    return { privyUserId: claims.user_id, expiresAt: new Date(claims.expiration * 1000) };
  }

  async fetchProfile(privyUserId: string): Promise<PrivyProfile | null> {
    if (!this.client) return null;
    try {
      const user = await this.client.users()._get(privyUserId);
      return profileFromLinkedAccounts(user.linked_accounts);
    } catch (error) {
      this.logger.warn(`Could not fetch Privy profile for ${privyUserId}: ${(error as Error).message}`);
      return null;
    }
  }
}
