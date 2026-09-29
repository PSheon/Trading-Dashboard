import { Injectable, Logger } from "@nestjs/common";
import { PrivyClient, type LinkedAccount } from "@privy-io/node";

import { env } from "../../config/env.js";

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
 * person trades from. */
export function profileFromLinkedAccounts(accounts: LinkedAccount[]): PrivyProfile {
  let email: string | null = null;
  let oauthEmail: string | null = null;
  let external: string | null = null;
  let embedded: string | null = null;
  for (const account of accounts) {
    if (account.type === "email" && !email) email = account.address;
    if ((account.type === "google_oauth" || account.type === "apple_oauth") && account.email) {
      oauthEmail ??= account.email;
    }
    if (account.type === "wallet" && "chain_type" in account && account.chain_type === "ethereum") {
      if (account.wallet_client === "privy") embedded ??= account.address;
      else external ??= account.address;
    }
  }
  const wallet = external ?? embedded;
  const chosen = email ?? oauthEmail;
  return { email: chosen?.toLowerCase() ?? null, walletAddress: wallet?.toLowerCase() ?? null };
}

/**
 * `@privy-io/node` (0.35): `new PrivyClient({ appId, appSecret,
 * jwtVerificationKey? })`, `client.utils().auth().verifyAccessToken(token)`
 * → `{ user_id, app_id, session_id, issuer, issued_at, expiration }`, and
 * `client.users()._get(userId)` → `User` with `linked_accounts`. With
 * `PRIVY_VERIFICATION_KEY` set, verification is local (no network call);
 * without it the SDK fetches and caches the app's JWKS.
 */
@Injectable()
export class SdkPrivyVerifier implements PrivyVerifier {
  private readonly logger = new Logger(SdkPrivyVerifier.name);
  private readonly client: PrivyClient | null;

  constructor() {
    const appId = env.privyAppId();
    const appSecret = env.privyAppSecret();
    if (!appId || !appSecret) {
      this.logger.warn("PRIVY_APP_ID / PRIVY_APP_SECRET not set — Privy sign-in is disabled");
      this.client = null;
      return;
    }
    this.client = new PrivyClient({
      appId,
      appSecret,
      jwtVerificationKey: env.privyVerificationKey(),
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
