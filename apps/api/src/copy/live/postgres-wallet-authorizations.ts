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
  // Not a constructor parameter: Nest builds this provider with the
  // database alone (the normal, purpose-less source).
  private purpose?: GrantPurpose;
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}
  /** The stop executor's source (see GrantPurpose). */
  static forPurpose(db: DrizzleDb, purpose?: GrantPurpose): PostgresWalletAuthorizationSource {
    const source = new PostgresWalletAuthorizationSource(db);
    source.purpose = purpose;
    return source;
  }
  async find(id: string): Promise<WalletAuthorization | null> {
    return findCurrentWalletAuthorization(this.db, id, this.purpose);
  }
}

/** Who loads the grant for signing. Only the stop executor ('stop': the
 * stop's reduce-only closes and its owner-consented cancellations) may use a
 * grant whose revocation an admin requested, or of an owner an admin
 * disabled. */
export type GrantPurpose = 'stop';

/** The scopes a grant authorises for `purpose`: all of them normally; once
 * an admin requested its revocation, nothing, except copy:reduce for the
 * stop executor (the copy is being stopped with it). */
export function effectiveGrantScopes<T extends string>(scopes: readonly T[], revokeRequestedAt: Date | null, purpose?: GrantPurpose): T[] {
  if (!revokeRequestedAt) return [...scopes];
  return purpose === 'stop' ? scopes.filter(scope => scope === 'copy:reduce') : [];
}

/** The caller supplies its transaction/connection. This query never opens a
 * second pool while the actual execution's original session owns user locks. */
export async function findCurrentWalletAuthorization(db: DbExecutor, id: string, purpose?: GrantPurpose): Promise<WalletAuthorization | null> {
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
    // A disabled owner's grant signs nothing new, except a stop's closes:
    // disabling a user must not strand the positions its copies hold.
    if (!row || (row.disabledAt !== null && purpose !== 'stop') || row.wallet.retiredAt !== null) return null;
    const { grant, wallet } = row;
    return { id: grant.id, version: grant.version, userId: wallet.userId, strategyId: wallet.strategyId, walletId: wallet.privyWalletId,
      privyOwnerId: wallet.privyOwnerId, accountAddress: address(wallet.accountAddress), signerAddress: address(wallet.signerAddress), network: wallet.network,
      // Revoke requested by an admin: nothing, or the stop's reduce-only closes.
      scopes: effectiveGrantScopes(grant.scopes, grant.revokeRequestedAt, purpose), validFrom: grant.validFrom.getTime(), expiresAt: grant.expiresAt.getTime(), revokedAt: grant.revokedAt?.getTime() ?? null,
      exchangeApprovedAt: grant.exchangeApprovedAt?.getTime() ?? null };
}
