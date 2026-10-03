import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { users } from "@trading-dashboard/shared/database";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import { lockCopyUser } from "../copy/copy-user-lock.js";

/** The user row's wallet fields only; balances are never stored. */
@Injectable()
export class WalletRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  /** undefined when the user no longer exists. */
  async findWallet(userId: number) {
    const [row] = await this.db
      .select({ privyUserId: users.privyUserId, embeddedWalletAddress: users.embeddedWalletAddress })
      .from(users)
      .where(eq(users.id, userId));
    return row;
  }

  /** Store the Privy embedded wallet once; a stored address is never
   * replaced. Returns the address now on the row (null if the write lost to
   * a unique conflict, which Privy's one-wallet-per-user rules out). */
  async setEmbeddedWallet(userId: number, address: string): Promise<string | null> {
    try {
      await this.db.transaction(async tx => {
        await lockCopyUser(tx, userId);
        await tx.update(users).set({ embeddedWalletAddress: address })
          .where(and(eq(users.id, userId), isNull(users.embeddedWalletAddress)));
      });
    } catch (error) {
      if ((error as { code?: string })?.code !== "23505") throw error;
    }
    return (await this.findWallet(userId))?.embeddedWalletAddress ?? null;
  }
}
