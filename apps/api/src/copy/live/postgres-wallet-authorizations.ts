import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { copyExecutionWallets, copyWalletAuthorizations, users } from "@trading-dashboard/shared/database";
import { DRIZZLE_CLIENT } from "../../db/db.constants.js";
import type { DrizzleDb } from "../../db/drizzle.provider.js";
import { address, type WalletAuthorization, type WalletAuthorizationSource } from "./wallet-authorization.js";

/** Only verified provisioning may populate these grants. User requests never
 * supply exchangeApprovedAt, owner quorum or wallet metadata. */
@Injectable()
export class PostgresWalletAuthorizationSource implements WalletAuthorizationSource {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}
  async find(id: string): Promise<WalletAuthorization | null> {
    const [row] = await this.db.select({ grant: copyWalletAuthorizations, wallet: copyExecutionWallets, disabledAt: users.disabledAt }).from(copyWalletAuthorizations)
      .innerJoin(copyExecutionWallets, eq(copyExecutionWallets.id, copyWalletAuthorizations.walletId))
      .innerJoin(users, eq(users.id, copyExecutionWallets.userId)).where(eq(copyWalletAuthorizations.id, id));
    if (!row || row.disabledAt !== null) return null;
    const { grant, wallet } = row;
    return { id: grant.id, version: grant.version, userId: wallet.userId, strategyId: wallet.strategyId, walletId: wallet.privyWalletId,
      privyOwnerId: wallet.privyOwnerId, accountAddress: address(wallet.accountAddress), signerAddress: address(wallet.signerAddress), network: wallet.network,
      scopes: grant.scopes, validFrom: grant.validFrom.getTime(), expiresAt: grant.expiresAt.getTime(), revokedAt: grant.revokedAt?.getTime() ?? null,
      exchangeApprovedAt: grant.exchangeApprovedAt?.getTime() ?? null };
  }
}
