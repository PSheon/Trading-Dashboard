import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { adminRevokeLiveGrantSchema, type AdminLiveAccounts, type AdminLiveLatency, type AdminLiveOrders, type AdminLiveTransfers, type AdminRevokedLiveGrant } from '@trading-dashboard/shared/contracts';
import { recordAdminAudit } from '../common/audit/admin-audit.js';
import type { RequestUser } from '../common/auth/current-user.js';
import { parseOr400 } from '../common/http/validation.js';
import { UnitOfWork } from '../db/unit-of-work.js';
import { CopyAdminLiveRepository } from './copy-admin-live.repository.js';

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
  constructor(private readonly repository: CopyAdminLiveRepository, private readonly uow: UnitOfWork) {}
  async accounts(): Promise<AdminLiveAccounts> { return { items: await this.repository.accounts() }; }
  async transfers(): Promise<AdminLiveTransfers> { return { items: await this.repository.transfers() }; }
  async orders(state: 'open' | 'unknown' | 'all'): Promise<AdminLiveOrders> { return { items: await this.repository.orders(state) }; }
  latency(window: '24h' | '7d'): Promise<AdminLiveLatency> { return this.repository.latency(window, this.now()); }

  async revoke(id: string, input: unknown, actor: RequestUser): Promise<AdminRevokedLiveGrant> {
    const { reason } = parseOr400(adminRevokeLiveGrantSchema, input);
    return this.uow.run(async tx => {
      const row = await this.repository.lockedGrant(tx, id);
      if (!row) throw new NotFoundException('Wallet authorization not found');
      if (row.grant.revokedAt) return { id, version: row.grant.version, revokedAt: row.grant.revokedAt.toISOString() };
      if (row.grant.version === 2_147_483_647) throw new ConflictException('authorization_version_exhausted');
      const now = this.now(), grant = await this.repository.revokeGrant(tx, id, row.grant.version + 1, now);
      await this.repository.recordRevocation(tx, { id: randomUUID(), authorizationId: id, userId: row.wallet.userId, version: grant.version, action: 'revoked', createdAt: now });
      await recordAdminAudit(tx, actor, 'copy.grant.revoke', `grant:${id}`, { version: row.grant.version, revokedAt: null, userId: row.wallet.userId, strategyId: row.wallet.strategyId },
        { version: grant.version, revokedAt: now.toISOString(), reason });
      return { id, version: grant.version, revokedAt: now.toISOString() };
    });
  }
}
