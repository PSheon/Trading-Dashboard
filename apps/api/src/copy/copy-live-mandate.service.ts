import { BadRequestException, Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { liveSourceNetworks, liveCopyOverviewSchema } from '@trading-dashboard/shared/contracts';
import { z } from 'zod';
import { AppConfig } from '../config/app-config.js';
import { UnitOfWork } from '../db/unit-of-work.js';
import { CopyLiveMandateRepository } from './copy-live-mandate.repository.js';
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
