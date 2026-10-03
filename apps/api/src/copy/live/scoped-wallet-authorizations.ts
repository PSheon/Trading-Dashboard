import { findCurrentWalletAuthorization } from './postgres-wallet-authorizations.js';
import { assertOriginalLiveRiskSession, type LiveRiskDatabaseSession } from './postgres-live-risk-scope.js';
import { LiveBoundaryError, type WalletAuthorization, type WalletAuthorizationSource } from './wallet-authorization.js';

/** Uncached local grant reads on the exact factory-issued execution session.
 * This is only local authorization; the executor still needs fresh exchange
 * approval and the trusted account-risk permit at both financial boundaries. */
export class ScopedWalletAuthorizationSource implements WalletAuthorizationSource {
  constructor(private readonly session: LiveRiskDatabaseSession, private readonly authorizationId: string) {
    assertOriginalLiveRiskSession(session);
    if (typeof authorizationId !== 'string' || !authorizationId || authorizationId.length > 160)
      throw new LiveBoundaryError('wallet_authorization_scope_mismatch');
  }
  async find(id: string): Promise<WalletAuthorization | null> {
    assertOriginalLiveRiskSession(this.session);
    if (id !== this.authorizationId) throw new LiveBoundaryError('wallet_authorization_scope_mismatch');
    return this.session.read(async db => {
      const grant = await findCurrentWalletAuthorization(db, id);
      await this.session.scope.assertHeld();
      const identity = this.session.scope.identity;
      if (grant && (grant.userId !== identity.userId || grant.network !== identity.network || grant.accountAddress !== identity.accountAddress))
        throw new LiveBoundaryError('wallet_authorization_scope_mismatch');
      return grant;
    });
  }
}
