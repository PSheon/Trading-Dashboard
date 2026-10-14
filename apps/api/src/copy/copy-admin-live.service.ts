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

/** Admin live operations (B16). Reads need copy.read; revoking a grant needs execution.pause and
 * stops every new order of that wallet at once (`wallet_authorization_revoked`). */
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
   * Revoking a grant with positions left would strand them: the stop executor needs it (review 6a).
   * - `force`: revoked now (audited with positionsMayRemain);
   * - copy ended or never traded: revoked now;
   * - otherwise the copy is stopped and the grant marked revoke-requested: it then authorises only
   *   that stop's closes and consented cancels, and is revoked when the stop ends, blocks or goes,
   *   or after the deadline once flat (expirePendingRevokes);
   * - asked again while pending: revoked now if the stop is blocked or gone.
   * Audited as copy.grant.revoke.
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
          // Keyed by generation, not grant version, so a later generation never gets an old stop.
          stop = await this.stops.request(tx, copy.activated.userId, copy.activated.id,
            { idempotencyKey: `admin-revoke-${id}-${copy.activated.id}-${copy.activated.revision}`.slice(0, 128), expectedMandateRevision: copy.activated.revision }, () => now.getTime());
        } catch (error) {
          // Can't be stopped: don't revoke into a stranded account (force remains available).
          if (error instanceof HttpException) throw new ConflictException({ statusCode: 409, code: 'live_revoke_needs_stop',
            message: 'This copy could not be stopped, so its grant was not revoked (a stop needs it to close the positions). Check the copy\'s stop, or revoke now (force) if positions may stay open.' });
          throw error;
        }
      }
      // A blocked or ended stop cannot use the grant: revoke now.
      if (!stop || stop.state === 'stopped') return revokeNow('stop_not_open');
      if (stop.state === 'blocked') return revokeNow('stop_blocked');
      const grant = await this.repository.requestRevoke(tx, id, now);
      await recordAdminAudit(tx, actor, 'copy.grant.revoke', `grant:${id}`, before,
        { version: grant.version, revokedAt: null, revokeRequestedAt: now.toISOString(), stopId: stop.id, reason });
      return pendingAnswer(grant, stop.id);
    });
  }
}
