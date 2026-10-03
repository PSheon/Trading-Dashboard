import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { copyAgentSetups, copyExecutionAccounts, copyExecutionWallets, copyStrategies, copyWalletAuthorizations, users } from "@trading-dashboard/shared/database";
import { DRIZZLE_CLIENT } from "../../db/db.constants.js";
import type { DrizzleDb } from "../../db/drizzle.provider.js";
import type { DbExecutor } from '../../db/unit-of-work.js';
import { address, type WalletAuthorization, type WalletAuthorizationSource } from "./wallet-authorization.js";

/** Only verified provisioning may populate these grants. User requests never
 * supply exchangeApprovedAt, owner quorum or wallet metadata. */
@Injectable()
export class PostgresWalletAuthorizationSource implements WalletAuthorizationSource {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}
  async find(id: string): Promise<WalletAuthorization | null> {
    return findCurrentWalletAuthorization(this.db, id);
  }
}

/** The caller supplies its transaction/connection. This query never opens a
 * second pool while the actual execution's original session owns user locks. */
export async function findCurrentWalletAuthorization(db: DbExecutor, id: string): Promise<WalletAuthorization | null> {
    const [row] = await db.select({ grant: copyWalletAuthorizations, wallet: copyExecutionWallets, disabledAt: users.disabledAt }).from(copyWalletAuthorizations)
      .innerJoin(copyExecutionWallets, eq(copyExecutionWallets.id, copyWalletAuthorizations.walletId))
      .innerJoin(users, eq(users.id, copyExecutionWallets.userId))
      .innerJoin(copyAgentSetups, and(eq(copyAgentSetups.authorizationId, copyWalletAuthorizations.id),
        eq(copyAgentSetups.state, 'active'), eq(copyAgentSetups.userId, users.id),
        eq(copyAgentSetups.strategyId, copyExecutionWallets.strategyId), eq(copyAgentSetups.network, copyExecutionWallets.network),
        eq(copyAgentSetups.accountAddress, copyExecutionWallets.accountAddress), eq(copyAgentSetups.agentWalletId, copyExecutionWallets.privyWalletId),
        eq(copyAgentSetups.agentOwnerQuorumId, copyExecutionWallets.privyOwnerId), eq(copyAgentSetups.agentAddress, copyExecutionWallets.signerAddress),
        eq(copyAgentSetups.expiresAt, copyWalletAuthorizations.expiresAt)))
      .innerJoin(copyExecutionAccounts, and(eq(copyExecutionAccounts.id, copyAgentSetups.accountId),
        eq(copyExecutionAccounts.state, 'ready'), eq(copyExecutionAccounts.userId, users.id),
        eq(copyExecutionAccounts.privyUserId, users.privyUserId), eq(copyExecutionAccounts.strategyId, copyExecutionWallets.strategyId),
        eq(copyExecutionAccounts.network, copyExecutionWallets.network), eq(copyExecutionAccounts.address, copyExecutionWallets.accountAddress),
        eq(copyExecutionAccounts.privyWalletId, copyAgentSetups.accountWalletId), eq(copyExecutionAccounts.ownerQuorumId, copyAgentSetups.accountOwnerQuorumId)))
      .innerJoin(copyStrategies, and(eq(copyStrategies.id, copyExecutionWallets.strategyId), eq(copyStrategies.userId, users.id)))
      .where(eq(copyWalletAuthorizations.id, id));
    if (!row || row.disabledAt !== null || row.wallet.retiredAt !== null) return null;
    const { grant, wallet } = row;
    return { id: grant.id, version: grant.version, userId: wallet.userId, strategyId: wallet.strategyId, walletId: wallet.privyWalletId,
      privyOwnerId: wallet.privyOwnerId, accountAddress: address(wallet.accountAddress), signerAddress: address(wallet.signerAddress), network: wallet.network,
      scopes: grant.scopes, validFrom: grant.validFrom.getTime(), expiresAt: grant.expiresAt.getTime(), revokedAt: grant.revokedAt?.getTime() ?? null,
      exchangeApprovedAt: grant.exchangeApprovedAt?.getTime() ?? null };
}
