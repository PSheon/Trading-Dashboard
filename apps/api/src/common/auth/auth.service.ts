import { createHash, timingSafeEqual } from "node:crypto";

import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { alertRules, users } from "@trading-dashboard/shared";

import { env } from "../../config/env.js";
import { DRIZZLE_CLIENT } from "../../db/db.constants.js";
import type { DrizzleDb } from "../../db/drizzle.provider.js";
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

/** A verified token's outcome is trusted this long at most, even when the
 * token expires later: disabling a user, changing a role or opening
 * sign-ups takes effect within this window (or at once, through
 * `invalidateUser` / `clearCache`). */
const CACHE_TTL_MS = 30_000;
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
}

type UserRow = typeof users.$inferSelect;

export type SignInResult =
  | { status: "ok"; user: UserRow }
  | { status: "disabled"; userId: number }
  | { status: "signups_closed" };

/**
 * Turns a bearer token into a caller:
 * - equal to API_AUTH_TOKEN → `{ kind: "service" }` (server to server);
 * - otherwise a Privy access token → the `users` row for that Privy DID,
 *   created on first sign-in (with a copy of the default alert rules)
 *   unless sign-ups are closed.
 *
 * Outcomes of verified tokens are cached (keyed by a hash, never the raw
 * token) until the token expires or CACHE_TTL_MS passes, whichever is
 * first, so a signed-in page doesn't cost a signature check and two
 * queries per request. Invalid tokens are not cached.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb,
    @Inject(PRIVY_VERIFIER) private readonly privy: PrivyVerifier,
    private readonly settings: SettingsService,
  ) {}

  /** Database errors propagate; token problems never do. */
  async authenticate(token: string): Promise<AuthOutcome> {
    const serviceToken = env.apiAuthToken();
    if (serviceToken && tokensMatch(token, serviceToken)) {
      return { status: "user", user: { kind: "service" } };
    }

    const key = tokenKey(token);
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached) {
      if (cached.expiresAt > now) return cached.outcome;
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
    this.remember(key, outcome, Math.min(verified.expiresAt.getTime(), now + CACHE_TTL_MS));
    return outcome;
  }

  /** The caller for this token, or null when it isn't one. */
  async resolve(token: string): Promise<RequestUser | null> {
    const outcome = await this.authenticate(token);
    return outcome.status === "user" ? outcome.user : null;
  }

  /** Forgets every cached token of this user, so a disable, re-enable or
   * role change applies to their next request instead of within 30 s. */
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

  private remember(key: string, outcome: CachedOutcome, expiresAt: number): void {
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      // Map iterates in insertion order: drop the oldest entry.
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { outcome, expiresAt });
  }

  /**
   * Returning user: bump `last_login_at` (unless disabled). New user: fetch
   * email/wallet from Privy (best effort); when sign-ups are closed only a
   * BOOTSTRAP_ADMIN_EMAILS address gets in. The new row is admin when its
   * email is in that list, and gets its own copy of the default rules
   * (`alert_rules` rows with no owner) in the same transaction, so a user
   * never exists without their rules.
   */
  async signIn(privyUserId: string): Promise<SignInResult> {
    const [existing] = await this.db
      .update(users)
      .set({ lastLoginAt: new Date() })
      .where(and(eq(users.privyUserId, privyUserId), isNull(users.disabledAt)))
      .returning();
    if (existing) return { status: "ok", user: existing };

    const known = await this.findByPrivyId(privyUserId);
    if (known) return this.asResult(known);

    const profile = await this.privy.fetchProfile(privyUserId);
    const email = profile?.email ?? null;
    const bootstrapAdmin = email !== null && env.bootstrapAdminEmails().includes(email);
    if (!bootstrapAdmin && !(await this.settings.get("general")).signupsOpen) {
      return { status: "signups_closed" };
    }

    const created = await this.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(users)
        .values({
          privyUserId,
          email,
          walletAddress: profile?.walletAddress ?? null,
          role: bootstrapAdmin ? "admin" : "user",
        })
        // Two first requests racing: the loser reads the winner's row below.
        .onConflictDoNothing({ target: users.privyUserId })
        .returning();
      if (!inserted) return undefined;

      await tx.execute(sql`
        insert into ${alertRules} (user_id, scope, kind, params_json, cooldown_s, quiet_hours, tiers, enabled)
        select ${inserted.id}, scope, kind, params_json, cooldown_s, quiet_hours, tiers, enabled
        from ${alertRules}
        where ${isNull(alertRules.userId)}
        on conflict do nothing
      `);
      return inserted;
    });
    if (created) {
      this.logger.log(`New user ${created.id} (${privyUserId})${bootstrapAdmin ? " — bootstrap admin" : ""}`);
      return { status: "ok", user: created };
    }

    const raced = await this.findByPrivyId(privyUserId);
    if (!raced) throw new Error(`User ${privyUserId} vanished during sign-in`);
    return this.asResult(raced);
  }

  private async findByPrivyId(privyUserId: string): Promise<UserRow | undefined> {
    const [row] = await this.db.select().from(users).where(eq(users.privyUserId, privyUserId));
    return row;
  }

  private asResult(row: UserRow): SignInResult {
    return row.disabledAt ? { status: "disabled", userId: row.id } : { status: "ok", user: row };
  }
}
