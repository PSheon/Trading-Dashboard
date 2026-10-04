import { ConflictException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { adminRevokeLiveGrantSchema, type AdminLiveAccounts, type AdminLiveLatency, type AdminLiveOrders, type AdminLiveTransfers, type AdminRevokedLiveGrant } from '@trading-dashboard/shared/contracts';
import { recordAdminAudit } from '../common/audit/admin-audit.js';
import type { RequestUser } from '../common/auth/current-user.js';
import { parseOr400 } from '../common/http/validation.js';
import { UnitOfWork } from '../db/unit-of-work.js';
import { CopyAdminLiveRepository } from './copy-admin-live.repository.js';
import { CopyLiveStopRepository } from './copy-live-stop.repository.js';

/**
 * B16 admin live operations over testnet copies. Reads need copy.read (the
 * controller); revoking a copy's trading grant needs execution.pause and is
 * audited (copy.grant.revoke) in the same transaction. A revoked grant stops
 * every new order of that wallet at once (the risk authority refuses
 * `wallet_authorization_revoked`); the owner prepares a new mandate to resume.
 */
@Injectable()
export class CopyAdminLiveService {
  /** Replaced in tests. */
  now: () => Date = () => new Date();
  constructor(private readonly repository: CopyAdminLiveRepository, private readonly uow: UnitOfWork, private readonly stops: CopyLiveStopRepository) {}
  async accounts(): Promise<AdminLiveAccounts> { return { items: await this.repository.accounts() }; }
  async transfers(): Promise<AdminLiveTransfers> { return { items: await this.repository.transfers() }; }
  async orders(state: 'open' | 'unknown' | 'all'): Promise<AdminLiveOrders> { return { items: await this.repository.orders(state) }; }
  latency(window: '24h' | '7d'): Promise<AdminLiveLatency> { return this.repository.latency(window, this.now()); }

  /**
   * Revoking a grant whose copy may still hold positions or resting orders
   * would strand them: the stop executor closes and cancels with that grant,
   * so with it revoked a stop stays in closing forever and the owner can
   * neither pause, prepare a new mandate nor close by hand (testnet
   * regression review, 6a). So a revoke never leaves a copy without a way
   * out:
   * - the copy is stopped or never traded (no generation, or one that was
   *   never activated): the grant is revoked at once;
   * - otherwise the copy is stopped now (strategy stopping, new risk and
   *   reductions only: no new order can open risk), with the account's stop
   *   if one is running or a new one, and the grant is marked revoke
   *   requested; the stop executor revokes it when that stop ends. Until
   *   then it signs only the stop's reduce-only closes and the cancellations
   *   the owner consents to.
   * Audited as copy.grant.revoke either way, with the reason.
   */
  async revoke(id: string, input: unknown, actor: RequestUser): Promise<AdminRevokedLiveGrant> {
    const { reason } = parseOr400(adminRevokeLiveGrantSchema, input);
    return this.uow.run(async tx => {
      const row = await this.repository.lockedGrant(tx, id);
      if (!row) throw new NotFoundException('Wallet authorization not found');
      const answer = (grant: typeof row.grant, stopId: string | null): AdminRevokedLiveGrant => ({ id, version: grant.version, revokedAt: grant.revokedAt?.toISOString() ?? null,
        revokeRequestedAt: grant.revokedAt ? null : grant.revokeRequestedAt?.toISOString() ?? null, stopId: grant.revokedAt ? null : stopId });
      const copy = await this.repository.grantCopy(tx, id);
      if (row.grant.revokedAt || row.grant.revokeRequestedAt) return answer(row.grant, copy?.stop?.id ?? null);
      if (row.grant.version === 2_147_483_647) throw new ConflictException('authorization_version_exhausted');
      const now = this.now();
      const before = { version: row.grant.version, revokedAt: null, userId: row.wallet.userId, strategyId: row.wallet.strategyId };
      let stop = copy?.stop ?? null;
      const live = copy && copy.strategy.status !== 'stopped' && copy.mandate.activationCursor !== null && copy.mandate.state !== 'prepared';
      if (copy && live && !stop) {
        try {
          stop = await this.stops.request(tx, copy.mandate.userId, copy.mandate.id,
            { idempotencyKey: `admin-revoke-${id}-${row.grant.version}`.slice(0, 128), expectedMandateRevision: copy.mandate.revision }, () => now.getTime());
        } catch (error) {
          // The copy cannot be stopped from here (its records disagree): do
          // not revoke into a stranded account; the admin sees why.
          if (error instanceof HttpException) throw new ConflictException({ statusCode: 409, code: 'live_revoke_needs_stop',
            message: 'This copy could not be stopped, so its grant was not revoked (a stop needs it to close the positions). Check the copy\'s stop.' });
          throw error;
        }
      }
      if (copy && (live || stop)) {
        const grant = await this.repository.requestRevoke(tx, id, now);
        await recordAdminAudit(tx, actor, 'copy.grant.revoke', `grant:${id}`, before,
          { version: grant.version, revokedAt: null, revokeRequestedAt: now.toISOString(), stopId: stop?.id ?? null, reason });
        return answer(grant, stop?.id ?? null);
      }
      const grant = await this.repository.revokeGrant(tx, id, row.grant.version + 1, now);
      await this.repository.recordRevocation(tx, { id: randomUUID(), authorizationId: id, userId: row.wallet.userId, version: grant.version, action: 'revoked', createdAt: now });
      await recordAdminAudit(tx, actor, 'copy.grant.revoke', `grant:${id}`, before, { version: grant.version, revokedAt: now.toISOString(), reason });
      return answer(grant, null);
    });
  }
}
