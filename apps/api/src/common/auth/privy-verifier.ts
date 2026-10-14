import { AppConfig } from "../../config/app-config.js";
import { Injectable, Logger } from "@nestjs/common";
import { PrivyClient, type LinkedAccount } from "@privy-io/node";
import { isPrivyWallet, primaryEmbeddedWalletAddress, type EmbeddedWalletIdentity } from "@trading-dashboard/shared/contracts";
import { safeErrorText } from "../../runtime/safe-error-text.js";
import { PRIVY_TIMEOUT_MS } from '../../config/constants/http.js';


/** A Privy access token that passed signature, issuer, audience and expiry
 * checks. */
interface VerifiedPrivyToken {
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

/** `verifyAccessToken` throws on any invalid, expired or foreign token, and when Privy
 * isn't configured (fail closed). */
export interface PrivyVerifier {
  verifyAccessToken(accessToken: string): Promise<VerifiedPrivyToken>;
  /** Best effort; null when the profile can't be fetched. */
  fetchProfile(privyUserId: string): Promise<PrivyProfile | null>;
}

export const PRIVY_VERIFIER = Symbol("PRIVY_VERIFIER");

/** Email (email login, else Google/Apple) and wallet from linked accounts. An external
 * wallet wins for `walletAddress` (the person trades from it); the embedded one is also
 * returned on its own as the Orbie main account. */
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

/** `@privy-io/node` (0.35). With `PRIVY_VERIFICATION_KEY` set, token verification is
 * local; without it the SDK fetches and caches the app's JWKS. */
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
    // The SDK default (a minute, two retries) outlasts the request deadline; the JWKS
    // fetch is jose's own, bounded at 5 s.
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
      this.logger.warn(`Could not fetch Privy profile for ${privyUserId}: ${safeErrorText(error)}`);
      return null;
    }
  }
}
