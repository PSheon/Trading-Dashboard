import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { users } from "@trading-dashboard/shared/database";
import { DRIZZLE_CLIENT } from "../../db/db.constants.js";
import type { DrizzleDb } from "../../db/drizzle.provider.js";
import { recordAdminAudit } from "../audit/admin-audit.js";
import { lockCopyUser } from "../../copy/copy-user-lock.js";

/** Advisory-lock key serializing first-admin bootstraps. */
const BOOTSTRAP_LOCK = 7404;

export type AuthUserRow = typeof users.$inferSelect;

/** Identity persistence only; Privy verification and authorization policy live in AuthService. */
@Injectable()
export class AuthRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  /** Read persisted role/disable state without caching; undefined means the user was deleted. */
  async currentAuthorization(id: number) {
    const [row] = await this.db.select({ id: users.id, privyUserId: users.privyUserId, role: users.role, disabledAt: users.disabledAt })
      .from(users).where(eq(users.id, id));
    return row;
  }

  /** Update last login only for enabled users; undefined also covers unknown identities. */
  async touchEnabledUser(privyUserId: string) {
    const [row] = await this.db.update(users).set({ lastLoginAt: new Date() })
      .where(and(eq(users.privyUserId, privyUserId), isNull(users.disabledAt))).returning();
    return row;
  }

  async findByPrivyId(privyUserId: string) {
    const [row] = await this.db.select().from(users).where(eq(users.privyUserId, privyUserId));
    return row;
  }

  /** Return undefined when another first sign-in won the unique Privy DID insert. */
  async createIfAbsent(input: Pick<AuthUserRow, "privyUserId" | "email" | "walletAddress" | "role"> & { embeddedWalletAddress?: string | null; locale?: AuthUserRow["locale"] }) {
    // Concurrent first sign-ins share one identity; the loser reads the winner.
    return this.recoverConcurrentIdentity(input.privyUserId, async () => {
      const [row] = await this.db.insert(users).values(input)
        .onConflictDoNothing({ target: users.privyUserId }).returning();
      return row;
    });
  }

  /** PostgreSQL can report the other unique index (embedded wallet) while
   * concurrent speculative inserts of the same DID are resolving. Only an
   * actually committed row for that verified DID proves an identity winner.
   * A wallet collision with another DID remains a conflict; no row is changed.
   * Catch outside any transaction so a rolled-back bootstrap can be read. */
  private async recoverConcurrentIdentity(privyUserId: string, create: () => Promise<AuthUserRow | undefined>): Promise<AuthUserRow | undefined> {
    try { return await create(); }
    catch (error) {
      const cause = error && typeof error === "object" && "cause" in error ? error.cause : error;
      if (cause && typeof cause === "object" && "code" in cause && cause.code === "23505" && await this.findByPrivyId(privyUserId)) {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * First sign-in of an AUTH_ADMIN_EMAILS address. The row is `admin` only
   * while the site has no enabled admin: the list is how the first admin
   * comes to exist, not a standing grant. Otherwise a demoted admin could
   * delete the account (deletion keeps no identifier, by design) and sign
   * in again as a new row to get the role back. Once an admin exists,
   * further admins are made by an admin. Serialized, so two listed
   * addresses signing in together can't both see "no admin"; a bootstrap
   * is written to the audit log in the same transaction. Undefined when
   * another first sign-in of the same Privy DID won the insert.
   */
  async createBootstrapCandidate(input: Pick<AuthUserRow, "privyUserId" | "email" | "walletAddress"> & { embeddedWalletAddress?: string | null; locale?: AuthUserRow["locale"] }) {
    return this.recoverConcurrentIdentity(input.privyUserId, () => this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${sql.raw(String(BOOTSTRAP_LOCK))}, 0)`);
      const [admin] = await tx.select({ id: users.id }).from(users).where(and(eq(users.role, "admin"), isNull(users.disabledAt))).limit(1);
      const role = admin ? "user" as const : "admin" as const;
      const [row] = await tx.insert(users).values({ ...input, role }).onConflictDoNothing({ target: users.privyUserId }).returning();
      if (row && role === "admin") await recordAdminAudit(tx, null, "user.bootstrap", String(row.id), null, { role: "admin", source: "AUTH_ADMIN_EMAILS" });
      return row;
    }));
  }

  /** Record the Privy embedded wallet once. It never changes for a Privy user,
   * so an address already stored is kept (undefined = not updated, e.g.
   * another request stored it first or the address belongs to another row). */
  async setEmbeddedWallet(id: number, address: string) {
    const [row] = await this.db.transaction(async tx => {
      await lockCopyUser(tx, id);
      return tx.update(users).set({ embeddedWalletAddress: address })
        .where(and(eq(users.id, id), isNull(users.embeddedWalletAddress))).returning();
    })
      .catch((error: { code?: string }) => {
        // 23505: the address is already on another user row. Privy never
        // shares a wallet between users, so leave both rows as they are.
        if (error?.code === "23505") return [];
        throw error;
      });
    return row;
  }

  /** Refresh profile data without restoring a previously revoked role. */
  async updateEmail(id: number, email: string) {
    const [row] = await this.db.update(users).set({ email }).where(eq(users.id, id)).returning();
    return row;
  }
}
