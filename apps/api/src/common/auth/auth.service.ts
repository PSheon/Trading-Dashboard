import { AppConfig } from "../../config/app-config.js";
import { createHash, timingSafeEqual } from "node:crypto";

import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Locale } from "@trading-dashboard/shared/contracts";

import { AuthRepository, type AuthUserRow as UserRow } from "./auth.repository.js";
import { SettingsService } from "../../settings/settings.service.js";
import type { RequestUser } from "./current-user.js";
import { PRIVY_VERIFIER, type PrivyVerifier } from "./privy-verifier.js";
import { AUTH_CACHE_TTL_MS, AUTH_PROFILE_RETRY_MS, EMBEDDED_WALLET_RETRY_MS } from '../../config/constants/cache-ttls.js';

/** Constant-time equality: both sides are hashed first because `timingSafeEqual`
 * throws on unequal lengths, which would leak the token's length. */
function tokensMatch(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a).digest();
  const digestB = createHash("sha256").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

function tokenKey(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

const CACHE_MAX_ENTRIES = 5_000;

/**
 * What a bearer token amounts to:
 * - `user`: a signed-in caller (service token or an enabled Privy user);
 * - `disabled`: a valid Privy token for a user an admin disabled;
 * - `signups_closed`: a valid Privy token for someone new while sign-ups
 *   are closed (no user row is created);
 * - `invalid`: anything else (bad signature, expired, Privy unconfigured).
 * Only `user` is a caller; the guard maps the rest to anonymous/401/403.
 */
export type AuthOutcome =
  | { status: "user"; user: RequestUser }
  | { status: "disabled"; userId: number }
  | { status: "signups_closed" }
  | { status: "invalid" };

type CachedOutcome = Exclude<AuthOutcome, { status: "invalid" }>;

interface CacheEntry {
  outcome: CachedOutcome;
  expiresAt: number;
  tokenExpiresAt: number;
}


type SignInResult =
  | { status: "ok"; user: UserRow }
  | { status: "disabled"; userId: number }
  | { status: "signups_closed" };

/**
 * Bearer token → caller: AUTH_SERVICE_TOKEN → service; otherwise a Privy token →
 * the `users` row for that DID (created on first sign-in unless sign-ups are closed).
 * Verified outcomes are cached by token hash until token expiry or AUTH_CACHE_TTL_MS;
 * every request still re-reads DB authorization, so a cached role is never stale.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly cache = new Map<string, CacheEntry>();
  private readonly profileRetryAt = new Map<number, number>();

  constructor(
    private readonly config: AppConfig,
    private readonly repository: AuthRepository,
    @Inject(PRIVY_VERIFIER) private readonly privy: PrivyVerifier,
    private readonly settings: SettingsService,
  ) {}

  /** Database errors propagate; token problems never do. `hints.locale` seeds
   * only a newly created row's language. */
  async authenticate(token: string, hints: { locale?: Locale } = {}): Promise<AuthOutcome> {
    const serviceToken = this.config.value.auth.serviceToken;
    if (serviceToken && tokensMatch(token, serviceToken)) {
      return { status: "user", user: { kind: "service", permissions: this.config.value.auth.permissions } };
    }

    const key = tokenKey(token);
    const now = Date.now();
    const cached = this.cache.get(key);
    // A cached sign-ups refusal is dropped as soon as sign-ups reopen.
    if (cached?.outcome.status === "signups_closed" && cached.expiresAt > now && (await this.settings.get("general")).signupsOpen) this.cache.delete(key);
    else if (cached) {
      if (cached.expiresAt > now) {
        const current = await this.currentAuthorization(cached.outcome);
        // Only actual JWT expiry invalidates an admitted cache hit.
        return cached.tokenExpiresAt > Date.now() ? current : { status: "invalid" };
      }
      this.cache.delete(key);
    }

    let verified;
    try {
      verified = await this.privy.verifyAccessToken(token);
    } catch {
      return { status: "invalid" };
    }
    if (verified.expiresAt.getTime() <= now) return { status: "invalid" };

    const result = await this.signIn(verified.privyUserId, hints.locale);
    const outcome: CachedOutcome =
      result.status === "ok"
        ? {
            status: "user",
            user: { kind: "user", id: result.user.id, privyUserId: result.user.privyUserId, role: result.user.role },
          }
        : result;
    // Re-read: an admin may have changed this user during the profile fetch.
    const current = await this.currentAuthorization(outcome);
    if (verified.expiresAt.getTime() <= Date.now()) return { status: "invalid" };
    if (current.status !== "invalid") this.remember(key, current, Math.min(verified.expiresAt.getTime(), now + AUTH_CACHE_TTL_MS), verified.expiresAt.getTime());
    return current;
  }

  private async currentAuthorization(outcome: CachedOutcome): Promise<AuthOutcome> {
    const id = outcome.status === "disabled" ? outcome.userId
      : outcome.status === "user" && outcome.user.kind === "user" ? outcome.user.id : undefined;
    if (id === undefined) return outcome;
    const row = await this.repository.currentAuthorization(id);
    if (!row) return { status: "invalid" };
    if (row.disabledAt) return { status: "disabled", userId: row.id };
    return { status: "user", user: { kind: "user", id: row.id, privyUserId: row.privyUserId, role: row.role } };
  }

  /** The caller for this token, or null when it isn't one. */
  async resolve(token: string): Promise<RequestUser | null> {
    const outcome = await this.authenticate(token);
    return outcome.status === "user" ? outcome.user : null;
  }

  /** Drop local verification entries after administrative edits. Correctness
   * does not depend on broadcasting this hint: every instance reads the DB. */
  invalidateUser(userId: number): void {
    for (const [key, { outcome }] of this.cache) {
      const id =
        outcome.status === "user" && outcome.user.kind === "user"
          ? outcome.user.id
          : outcome.status === "disabled"
            ? outcome.userId
            : undefined;
      if (id === userId) this.cache.delete(key);
    }
  }

  /** Drops every cached token (tests). */
  clearCache(): void {
    this.cache.clear();
  }

  private remember(key: string, outcome: CachedOutcome, expiresAt: number, tokenExpiresAt: number): void {
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      // Map iterates in insertion order: drop the oldest entry.
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { outcome, expiresAt, tokenExpiresAt });
  }

  /**
   * Returning user: bump `last_login_at` (unless disabled) and refresh a missing
   * profile without changing their role.
   * New user: fetch email/wallet from Privy (best effort); with sign-ups closed only
   * an AUTH_ADMIN_EMAILS address gets in, and becomes admin if no enabled admin exists.
   * The row takes `locale` when given, since the web adopts the account's language on sign-in.
   */
  async signIn(privyUserId: string, locale?: Locale): Promise<SignInResult> {
    const existing = await this.repository.touchEnabledUser(privyUserId);
    if (existing) return { status: "ok", user: await this.refreshMissingProfile(existing) };

    const known = await this.repository.findByPrivyId(privyUserId);
    if (known) return this.asResult(known);

    const profile = await this.privy.fetchProfile(privyUserId);
    const email = profile?.email ?? null;
    const listed = email !== null && this.config.value.auth.adminEmails.includes(email);
    if (!listed && !(await this.settings.get("general")).signupsOpen) {
      return { status: "signups_closed" };
    }

    const values = {
      privyUserId,
      email,
      walletAddress: profile?.walletAddress ?? null,
      embeddedWalletAddress: profile?.embeddedWalletAddress ?? null,
      ...(locale ? { locale } : {}),
    };
    const created = listed
      ? await this.repository.createBootstrapCandidate(values)
      : await this.repository.createIfAbsent({ ...values, role: "user" });
    if (created) {
      this.logger.log(`New user ${created.id}${created.role === "admin" ? " — bootstrap admin (no admin existed)" : ""}`);
      return { status: "ok", user: created };
    }

    const raced = await this.repository.findByPrivyId(privyUserId);
    if (!raced) throw new Error(`User ${privyUserId} vanished during sign-in`);
    return this.asResult(raced);
  }

  /** Retry missing email / embedded wallet without changing role: a persisted
   * demotion must survive even when the email stays allowlisted. */
  private async refreshMissingProfile(user: UserRow): Promise<UserRow> {
    if (user.email !== null && user.embeddedWalletAddress !== null) return user;

    const now = Date.now();
    if ((this.profileRetryAt.get(user.id) ?? 0) > now) return user;
    this.profileRetryAt.set(user.id, now + (user.embeddedWalletAddress === null ? EMBEDDED_WALLET_RETRY_MS : AUTH_PROFILE_RETRY_MS));
    const profile = await this.privy.fetchProfile(user.privyUserId);
    const email = user.email ?? profile?.email ?? null;
    const embedded = user.embeddedWalletAddress ?? profile?.embeddedWalletAddress ?? null;
    if (email !== null && embedded !== null) this.profileRetryAt.delete(user.id);

    let row = user;
    if (email !== user.email && email !== null) row = await this.repository.updateEmail(user.id, email) ?? row;
    if (embedded !== user.embeddedWalletAddress && embedded !== null) {
      row = await this.repository.setEmbeddedWallet(user.id, embedded) ?? row;
    }
    return row;
  }

  private asResult(row: UserRow): SignInResult {
    return row.disabledAt ? { status: "disabled", userId: row.id } : { status: "ok", user: row };
  }
}
