import { AppConfig } from "../../config/app-config.js";
import { createHash, timingSafeEqual } from "node:crypto";

import { Inject, Injectable, Logger } from "@nestjs/common";

import { AuthRepository, type AuthUserRow as UserRow } from "./auth.repository.js";
import { SettingsService } from "../../settings/settings.service.js";
import type { RequestUser } from "./current-user.js";
import { PRIVY_VERIFIER, type PrivyVerifier } from "./privy-verifier.js";

/**
 * Constant-time string equality. `timingSafeEqual` itself throws on unequal
 * buffer lengths (which would leak the token's length through the branch,
 * even if not through timing), so both sides are hashed to a fixed-size
 * digest first.
 */
function tokensMatch(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a).digest();
  const digestB = createHash("sha256").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

function tokenKey(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

/** Signature/identity verification may be reused briefly. Persisted role and
 * disabled state are re-read for every request, including cache hits. */
const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 5_000;
/** A returning user with no email on file is looked up at Privy again at
 * most this often (they may have linked one since). */
const PROFILE_RETRY_MS = 10 * 60_000;

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


export type SignInResult =
  | { status: "ok"; user: UserRow }
  | { status: "disabled"; userId: number }
  | { status: "signups_closed" };

/**
 * Turns a bearer token into a caller:
 * - equal to AUTH_SERVICE_TOKEN → `{ kind: "service" }` (server to server);
 * - otherwise a Privy access token → the `users` row for that Privy DID,
 *   created on first sign-in unless sign-ups are closed.
 *
 * Outcomes of verified tokens are cached (keyed by a hash, never the raw
 * token) until the token expires or CACHE_TTL_MS passes, whichever is
 * first. Every request still reads current database authorization; cached
 * outcomes never grant a stale role. Invalid tokens are not cached.
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

  /** Database errors propagate; token problems never do. */
  async authenticate(token: string): Promise<AuthOutcome> {
    const serviceToken = this.config.value.auth.serviceToken;
    if (serviceToken && tokensMatch(token, serviceToken)) {
      return { status: "user", user: { kind: "service", permissions: this.config.value.auth.permissions } };
    }

    const key = tokenKey(token);
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached) {
      if (cached.expiresAt > now) {
        const current = await this.currentAuthorization(cached.outcome);
        // Crossing the cache TTL only affects the next verification lookup.
        // Only actual JWT expiry invalidates the already-admitted cache hit.
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

    const result = await this.signIn(verified.privyUserId);
    const outcome: CachedOutcome =
      result.status === "ok"
        ? {
            status: "user",
            user: { kind: "user", id: result.user.id, privyUserId: result.user.privyUserId, role: result.user.role },
          }
        : result;
    // Profile refresh may await a remote call while an administrator changes
    // this user. Re-read after that work before publishing an authorization.
    const current = await this.currentAuthorization(outcome);
    if (verified.expiresAt.getTime() <= Date.now()) return { status: "invalid" };
    if (current.status !== "invalid") this.remember(key, current, Math.min(verified.expiresAt.getTime(), now + CACHE_TTL_MS), verified.expiresAt.getTime());
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

  /** Drops every cached token (tests; after opening sign-ups). */
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
   * Returning user: bump `last_login_at` (unless disabled), and refresh a
   * missing profile without changing their role.
   * New user: fetch
   * email/wallet from Privy (best effort); when sign-ups are closed only a
   * AUTH_ADMIN_EMAILS address gets in. The new row is admin when its
   * email is in that list. Nothing else is created with it: alerts are set
   * per favorite, and admins are alerted on the default rules themselves.
   */
  async signIn(privyUserId: string): Promise<SignInResult> {
    const existing = await this.repository.touchEnabledUser(privyUserId);
    if (existing) return { status: "ok", user: await this.refreshMissingProfile(existing) };

    const known = await this.repository.findByPrivyId(privyUserId);
    if (known) return this.asResult(known);

    const profile = await this.privy.fetchProfile(privyUserId);
    const email = profile?.email ?? null;
    const bootstrapAdmin = email !== null && this.config.value.auth.adminEmails.includes(email);
    if (!bootstrapAdmin && !(await this.settings.get("general")).signupsOpen) {
      return { status: "signups_closed" };
    }

    const created = await this.repository.createIfAbsent({
      privyUserId,
      email,
      walletAddress: profile?.walletAddress ?? null,
      embeddedWalletAddress: profile?.embeddedWalletAddress ?? null,
      role: bootstrapAdmin ? "admin" : "user",
    });
    if (created) {
      this.logger.log(`New user ${created.id}${bootstrapAdmin ? " — bootstrap admin" : ""}`);
      return { status: "ok", user: created };
    }

    const raced = await this.repository.findByPrivyId(privyUserId);
    if (!raced) throw new Error(`User ${privyUserId} vanished during sign-in`);
    return this.asResult(raced);
  }

  /** Retry missing profile data without changing authorization. Admin bootstrap
   * applies only when inserting a new user; a persisted demotion must survive
   * future authentication even when the email remains allowlisted. */
  private async refreshMissingProfile(user: UserRow): Promise<UserRow> {
    // A missing embedded wallet is backfilled the same way: users who signed
    // up before every account got one receive it at their next login.
    if (user.email !== null && user.embeddedWalletAddress !== null) return user;

    const now = Date.now();
    if ((this.profileRetryAt.get(user.id) ?? 0) > now) return user;
    this.profileRetryAt.set(user.id, now + PROFILE_RETRY_MS);
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
