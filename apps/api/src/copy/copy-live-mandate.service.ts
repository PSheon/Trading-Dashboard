import { BadRequestException, ConflictException, ForbiddenException, Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { liveSourceNetworks, copyIdempotencyKeySchema, approveLiveCopyMandateSchema, createLiveCopyStrategySchema, prepareLiveCopyMandateSchema, liveCopyOverviewSchema, liveCopyMandateChallengeSchema } from '@trading-dashboard/shared/contracts';
import { z } from 'zod';
import { AppConfig } from '../config/app-config.js';
import { UnitOfWork } from '../db/unit-of-work.js';
import { CopyLiveMandateRepository, type MandateRow } from './copy-live-mandate.repository.js';
import { verifyLiveCopyMandateConsent } from './copy-live-mandate-consent.js';
import { effectiveLiveLimits } from './copy-live-caps.js';
import { deploymentNetwork, liveExecutionEnabled } from './live-deployment.js';

function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException('Invalid live copy request');
  return structuredClone(parsed.data);
}
@Injectable()
export class CopyLiveMandateService {
  constructor(private readonly config: AppConfig, private readonly repository: CopyLiveMandateRepository,
    private readonly uow: UnitOfWork, @Optional() private readonly now: () => number = Date.now) {}
  private available() { if (this.config.value.copy.mode === 'disabled') throw new ServiceUnavailableException('Live preparation unavailable'); }
  private fresh(row: MandateRow) {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < row.nonce || now >= row.consentExpiresAt.getTime() || now >= row.expiresAt.getTime()) throw new ConflictException({ statusCode: 409, code: 'consent_expired', message: 'Mandate consent expired' });
    return now;
  }
  private renewal(row: MandateRow, now: number) {
    if (!Number.isSafeInteger(now) || now < row.nonce || now > 8640000000000000) throw new ServiceUnavailableException('Renewal observation clock unavailable');
    let reason: 'prepared_consent_expired' | 'generation_expired' | 'revoked' | null = null;
    if (row.state !== 'stopped') {
      if (row.state === 'revoked') reason = 'revoked';
      else if (now >= row.expiresAt.getTime()) reason = 'generation_expired';
      else if ((row.state === 'prepared' || row.state === 'expired') && now >= row.consentExpiresAt.getTime()) reason = 'prepared_consent_expired';
    }
    return { checkedAt: new Date(now).toISOString(), eligible: reason !== null, reason, mandateId: row.id, revision: row.revision, nonce: row.nonce };
  }
  private challenge(row: MandateRow) {
    const mandate = this.repository.wire(row), intent = this.repository.decode(row);
    const parsed = liveCopyMandateChallengeSchema.parse({ mandate, intent, renewal: this.renewal(row, this.now()) });
    // This observation never grants activation authority. Sample completion after
    // all SQL waits and response validation while the original owner lock is held.
    return { ...parsed, renewal: this.renewal(row, this.now()) };
  }
  /** The deployment's network, what this owner may start on it, and its
   * caps (the stricter of COPY_LIVE_* and the risk policy). */
  async overview(userId: number) {
    const data = await this.repository.overview(userId), owner = await this.repository.owner(userId);
    const network = deploymentNetwork(this.config), live = this.config.value.copy.live;
    let actualAllowed = liveExecutionEnabled(this.config);
    try { this.repository.assertAllowed(owner.privyUserId); } catch { actualAllowed = false; }
    const limits = live ? await this.repository.preparation(this.repository.reader()).catch(() => null) : null;
    const capped = limits ? effectiveLiveLimits(live?.caps, limits) : null;
    return liveCopyOverviewSchema.parse({ mode: 'actual', network, capabilities: { strategyPreparation: this.config.value.copy.mode !== 'disabled',
      automaticExecution: liveExecutionEnabled(this.config), sourceNetworks: [...liveSourceNetworks(network)], actualAllowed,
      ...(live ? { caps: { fixedPerTradeUsd: live.caps.fixedPerTradeUsd ?? null, maxAllocationUsd: capped?.maxAllocationUsd ?? live.caps.maxAllocationUsd ?? null,
        maxLeverage: capped?.maxLeverage ?? live.caps.maxLeverage ?? null, maxStrategiesPerUser: capped?.maxStrategiesPerUser ?? live.caps.maxStrategiesPerUser } } : {}) }, ...data });
  }
  async strategyByKey(userId: number, value: unknown) {
    const key = input(copyIdempotencyKeySchema, value);
    return this.uow.run(tx => this.repository.recoverStrategy(tx, userId, key));
  }
  async mandateByKey(userId: number, value: unknown) {
    const key = input(copyIdempotencyKeySchema, value);
    return this.uow.run(async tx => this.challenge(await this.repository.recoverMandate(tx, userId, { key })));
  }
  async originalChallenge(userId: number, id: string) {
    return this.uow.run(async tx => this.challenge(await this.repository.recoverMandate(tx, userId, { id })));
  }
  async create(userId: number, value: unknown) {
    const body = input(createLiveCopyStrategySchema, value);
    this.available();
    return this.uow.run(tx => this.repository.create(tx, userId, body, this.now));
  }
  async prepare(userId: number, accountId: string, value: unknown) {
    const body = input(prepareLiveCopyMandateSchema, value); this.available();
    return this.uow.run(async tx => {
      const row = await this.repository.prepare(tx, userId, accountId, body.idempotencyKey, this.now);
      return this.challenge(row);
    });
  }
  async approve(userId: number, id: string, value: unknown) {
    const body = input(approveLiveCopyMandateSchema, value); this.available();
    await this.repository.owner(userId);
    const original = await this.repository.find(userId, id);
    const intent = this.repository.decode(original); this.fresh(original);
    if (!await verifyLiveCopyMandateConsent(intent, body.consentSignature, this.now())) throw new ForbiddenException({ statusCode: 403, code: 'invalid_consent', message: 'Invalid owner consent' });
    return this.uow.run(async tx => {
      await this.repository.lock(tx, userId);
      const row = await this.repository.find(userId, id, tx, true);
      if (row.intentDigest !== original.intentDigest) throw new ConflictException('Mandate binding changed');
      const context = await this.repository.context(tx, userId, row.accountId, this.now());
      for (const [key, expected] of Object.entries(context.binding)) if (intent[key as keyof typeof intent] !== expected) throw new ConflictException('Mandate binding changed');
      if (context.grantExpiresAt < intent.expiresAt) throw new ConflictException('Grant lifetime changed');
      const now = this.fresh(row);
      const activated = await this.repository.activate(tx, row, body.consentSignature, now);
      const result = this.repository.wire(activated);
      this.fresh(row); // Check completion after every SQL wait and synchronous validation.
      return result;
    });
  }
  async pause(userId: number, id: string, value: unknown = {}) {
    input(z.object({}).strict(), value);
    return this.uow.run(async tx => this.repository.wire(await this.repository.barrier(tx, userId, id, 'paused', this.now)));
  }
  async resume(userId: number, id: string, value: unknown = {}) {
    input(z.object({}).strict(), value); this.available();
    return this.uow.run(async tx => this.repository.wire(await this.repository.resume(tx, userId, id, this.now)));
  }
  async revoke(userId: number, id: string, value: unknown = {}) {
    input(z.object({}).strict(), value);
    return this.uow.run(async tx => this.repository.wire(await this.repository.barrier(tx, userId, id, 'revoked', this.now)));
  }
}
