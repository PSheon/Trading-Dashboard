import { createHash, timingSafeEqual } from "node:crypto";

import { Inject, Injectable, Logger } from "@nestjs/common";
import { eq, isNull, sql } from "drizzle-orm";
import { alertRules, users } from "@trading-dashboard/shared";

import { env } from "../../config/env.js";
import { DRIZZLE_CLIENT } from "../../db/db.constants.js";
import type { DrizzleDb } from "../../db/drizzle.provider.js";
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

/** A verified token is trusted this long at most, even when it expires
 * later: a role change or deleted user takes effect within this window. */
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 5_000;

interface CacheEntry {
  user: RequestUser;
  expiresAt: number;
}

type UserRow = typeof users.$inferSelect;

/**
 * Turns a bearer token into a caller:
 * - equal to API_AUTH_TOKEN → `{ kind: "service" }` (server to server);
 * - otherwise a Privy access token → the `users` row for that Privy DID,
 *   created on first sign-in (with a copy of the default alert rules).
 *
 * Verified tokens are cached (keyed by a hash, never the raw token) until
 * the token expires or CACHE_TTL_MS passes, whichever is first, so a
 * signed-in page doesn't cost a signature check and two queries per request.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb,
    @Inject(PRIVY_VERIFIER) private readonly privy: PrivyVerifier,
  ) {}

  /** The caller for this token, or null if it isn't valid. Database errors
   * propagate; token problems never do. */
  async resolve(token: string): Promise<RequestUser | null> {
    const serviceToken = env.apiAuthToken();
    if (serviceToken && tokensMatch(token, serviceToken)) return { kind: "service" };

    const key = tokenKey(token);
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached) {
      if (cached.expiresAt > now) return cached.user;
      this.cache.delete(key);
    }

    let verified;
    try {
      verified = await this.privy.verifyAccessToken(token);
    } catch {
      return null;
    }
    if (verified.expiresAt.getTime() <= now) return null;

    const row = await this.signIn(verified.privyUserId);
    const user: RequestUser = { kind: "user", id: row.id, privyUserId: row.privyUserId, role: row.role };
    this.remember(key, user, Math.min(verified.expiresAt.getTime(), now + CACHE_TTL_MS));
    return user;
  }

  /** Drops every cached token (tests; after a role change). */
  clearCache(): void {
    this.cache.clear();
  }

  private remember(key: string, user: RequestUser, expiresAt: number): void {
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      // Map iterates in insertion order: drop the oldest entry.
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { user, expiresAt });
  }

  /**
   * Returning user: bump `last_login_at`. New user: fetch email/wallet from
   * Privy (best effort), make them admin when their email is in
   * BOOTSTRAP_ADMIN_EMAILS, and give them their own copy of the default
   * rules (`alert_rules` rows with no owner) — in one transaction, so a
   * user never exists without their rules.
   */
  async signIn(privyUserId: string): Promise<UserRow> {
    const [existing] = await this.db
      .update(users)
      .set({ lastLoginAt: new Date() })
      .where(eq(users.privyUserId, privyUserId))
      .returning();
    if (existing) return existing;

    const profile = await this.privy.fetchProfile(privyUserId);
    const email = profile?.email ?? null;
    const role = email && env.bootstrapAdminEmails().includes(email) ? "admin" : "user";

    const created = await this.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(users)
        .values({ privyUserId, email, walletAddress: profile?.walletAddress ?? null, role })
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
      this.logger.log(`New user ${created.id} (${privyUserId})${role === "admin" ? " — bootstrap admin" : ""}`);
      return created;
    }

    const [row] = await this.db.select().from(users).where(eq(users.privyUserId, privyUserId));
    return row;
  }
}
