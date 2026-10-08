import { Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import type { AppConfig } from '../../config/app-config.js';
import type { BackgroundJobs } from '../../runtime/background-jobs.service.js';
import { CopyLiveApiSettlementRepository } from './copy-live-api-settlement.repository.js';
import { CopyLiveSettlementClaims, type SettlementClaim } from './copy-live-settlement-claim.js';
import type { LiveSettleOutcome, LiveSettleRequest } from './copy-live-settler.js';

export interface ApiSettlementWork {
  repository: CopyLiveApiSettlementRepository;
  settle(request: LiveSettleRequest): Promise<LiveSettleOutcome>;
  saveSettlement(key: string): Promise<boolean>;
}
/** The API's only copy background exception: terminal testnet settlement.
 * No execution/signing/funding/source ingestion capability is injected. */
export class CopyLiveApiSettlementService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('CopyLiveApiSettlement');
  private running = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private readonly shutdown = new AbortController();
  constructor(private readonly config: AppConfig, private readonly jobs: BackgroundJobs,
    private readonly candidates: CopyLiveApiSettlementRepository, private readonly claims: CopyLiveSettlementClaims,
    private readonly work: (claim: SettlementClaim) => ApiSettlementWork) {}
  onApplicationBootstrap(): void {
    const c = this.config.value;
    if (c.app.nodeEnv === 'test' || c.app.isWorker || c.copy.live?.network !== 'testnet' || c.hyperliquid.wallet.network !== 'testnet') return;
    this.timer = setInterval(() => { void this.tick(); }, 3000); this.timer.unref?.();
  }
  onModuleDestroy(): void { this.stopped = true; this.shutdown.abort(); clearInterval(this.timer); }
  async tick(): Promise<void> {
    if (this.running || this.stopped || this.jobs.stopping || this.config.value.app.isWorker || this.config.value.copy.live?.network !== 'testnet' || this.config.value.hyperliquid.wallet.network !== 'testnet') return;
    this.running = true;
    try {
      await this.jobs.run(async () => {
        for (const key of await this.candidates.candidates()) {
          if (this.jobs.stopping || this.stopped) break;
          try { await this.claims.run(key, async claim => {
            const w = this.work(claim);
            const loaded = await w.repository.load(key); claim.assertFresh();
            if (!loaded) return;
            const outcome = await w.settle(loaded.request); claim.assertFresh();
            // Persist reporting before marking dispatch complete: a crash retains
            // submitted work and the original committed proof's replay path.
            if (outcome.kind === 'released' && !await w.saveSettlement(key)) return;
            claim.assertFresh();
            await w.repository.finish(loaded.row, outcome); claim.assertFresh();
          }, AbortSignal.any([this.jobs.signal, this.shutdown.signal])); } catch { this.logger.warn('Terminal settlement pending; durable journal retained'); }
        }
      });
    } catch { this.logger.warn('Terminal settlement admission pending'); }
    finally { this.running = false; }
  }
}
