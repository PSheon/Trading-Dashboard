import { ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { adminRevokeLiveGrantSchema, type AdminLiveAccounts, type AdminLiveLatency, type AdminLiveOrders, type AdminLiveTransfers, type AdminRevokedLiveGrant } from '@trading-dashboard/shared/contracts';
import { recordAdminAudit } from '../common/audit/admin-audit.js';
import type { RequestUser } from '../common/auth/current-user.js';
import { hasPermission } from '../common/auth/permissions.js';
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
   * regression review, 6a). So:
   * - `force`: revoked now, whatever the copy holds (audited with
   *   positionsMayRemain);
   * - the copy has ended or never traded (no activated generation on the
   *   account and no open stop): revoked now;
   * - otherwise the copy is stopped now (with the account's open stop, or a
   *   new one) and the grant marked revoke requested: from then on it
   *   authorises only that stop's reduce-only closes and owner-consented
   *   cancellations (effectiveGrantScopes), and it is revoked when the stop
   *   ends, when the stop is blocked or gone, or after the deadline,
   *   whichever comes first (CopyLiveStopWorkerRepository.expirePendingRevokes);
   * - asked again while pending: revoked now if the stop it waited for is
   *   blocked or no longer open, else the same pending answer.
   * Audited as copy.grant.revoke, with the reason.
   */
  async revoke(id: string, input: unknown, actor: RequestUser): Promise<AdminRevokedLiveGrant> {
    const { reason, force } = parseOr400(adminRevokeLiveGrantSchema, input);
    // Revoking now whatever the copy holds can leave positions nobody closes:
    // an admin's call (risk.manage), not an operator's (execution.pause only).
    if (force && !hasPermission(actor, 'risk.manage')) throw new ForbiddenException({ statusCode: 403, code: 'insufficient_permissions', message: 'Revoking at once (force) needs risk.manage' });
    return this.uow.run(async tx => {
      const row = await this.repository.lockedGrant(tx, id);
      if (!row) throw new NotFoundException('Wallet authorization not found');
      const pendingAnswer = (grant: typeof row.grant, stopId: string): AdminRevokedLiveGrant =>
        ({ id, version: grant.version, revokedAt: null, revokeRequestedAt: grant.revokeRequestedAt!.toISOString(), stopId });
      if (row.grant.revokedAt) return { id, version: row.grant.version, revokedAt: row.grant.revokedAt.toISOString(), revokeRequestedAt: null, stopId: null };
      if (row.grant.version === 2_147_483_647) throw new ConflictException('authorization_version_exhausted');
      const now = this.now();
      const before = { version: row.grant.version, revokedAt: null, revokeRequestedAt: row.grant.revokeRequestedAt?.toISOString() ?? null, userId: row.wallet.userId, strategyId: row.wallet.strategyId };
      const copy = await this.repository.grantCopy(tx, id);
      let stop = copy?.stop ?? null;
      const revokeNow = async (why: string) => {
        const grant = await this.repository.revokeGrant(tx, id, row.grant.version + 1, now);
        await this.repository.recordRevocation(tx, { id: randomUUID(), authorizationId: id, userId: row.wallet.userId, version: grant.version, action: 'revoked', createdAt: now });
        await recordAdminAudit(tx, actor, 'copy.grant.revoke', `grant:${id}`, before,
          { version: grant.version, revokedAt: now.toISOString(), reason, forced: Boolean(force), why, stopState: stop?.state ?? null, positionsMayRemain: why !== 'copy_ended' });
        return { id, version: grant.version, revokedAt: now.toISOString(), revokeRequestedAt: null, stopId: null };
      };
      if (force) return revokeNow('forced_by_admin');
      if (row.grant.revokeRequestedAt) {
        if (stop && stop.state !== 'blocked') return pendingAnswer(row.grant, stop.id);
        return revokeNow(stop ? 'stop_blocked' : 'stop_not_open');
      }
      const live = Boolean(copy?.strategy && copy.strategy.status !== 'stopped' && copy.activated);
      if (!live && !stop) return revokeNow('copy_ended');
      if (!stop && copy?.activated) {
        try {
          // Keyed by the generation, not the grant version (which a pending
          // revoke does not change): a later revoke of a later generation
          // must not get back an old, already stopped stop.
          stop = await this.stops.request(tx, copy.activated.userId, copy.activated.id,
            { idempotencyKey: `admin-revoke-${id}-${copy.activated.id}-${copy.activated.revision}`.slice(0, 128), expectedMandateRevision: copy.activated.revision }, () => now.getTime());
        } catch (error) {
          // The copy cannot be stopped from here (its records disagree): do
          // not revoke into a stranded account; the admin sees why (force
          // remains available).
          if (error instanceof HttpException) throw new ConflictException({ statusCode: 409, code: 'live_revoke_needs_stop',
            message: 'This copy could not be stopped, so its grant was not revoked (a stop needs it to close the positions). Check the copy\'s stop, or revoke now (force) if positions may stay open.' });
          throw error;
        }
      }
      // A stop that cannot run (blocked: its tracking is unproven) or has
      // already ended cannot use the grant: revoke now, said so in the audit.
      if (!stop || stop.state === 'stopped') return revokeNow('stop_not_open');
      if (stop.state === 'blocked') return revokeNow('stop_blocked');
      const grant = await this.repository.requestRevoke(tx, id, now);
      await recordAdminAudit(tx, actor, 'copy.grant.revoke', `grant:${id}`, before,
        { version: grant.version, revokedAt: null, revokeRequestedAt: now.toISOString(), stopId: stop.id, reason });
      return pendingAnswer(grant, stop.id);
    });
  }
}
