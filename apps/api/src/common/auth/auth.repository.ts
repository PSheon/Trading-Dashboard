import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { users } from "@trading-dashboard/shared/database";
import { DRIZZLE_CLIENT } from "../../db/db.constants.js";
import type { DrizzleDb } from "../../db/drizzle.provider.js";

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
    const [row] = await this.db.insert(users).values(input)
      .onConflictDoNothing({ target: users.privyUserId }).returning();
    return row;
  }

  /** Record the Privy embedded wallet once. It never changes for a Privy user,
   * so an address already stored is kept (undefined = not updated, e.g.
   * another request stored it first or the address belongs to another row). */
  async setEmbeddedWallet(id: number, address: string) {
    const [row] = await this.db.update(users).set({ embeddedWalletAddress: address })
      .where(and(eq(users.id, id), isNull(users.embeddedWalletAddress))).returning()
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
