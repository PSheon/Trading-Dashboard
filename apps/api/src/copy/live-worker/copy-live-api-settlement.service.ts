import { Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import type { AppConfig } from '../../config/app-config.js';
import type { BackgroundJobs } from '../../runtime/background-jobs.service.js';
import { errorLogFields } from '../../runtime/safe-error-text.js';
import { CopyLiveApiSettlementRepository } from './copy-live-api-settlement.repository.js';
import { CopyLiveSettlementClaims, type SettlementClaim } from './copy-live-settlement-claim.js';
import type { LiveSettleOutcome, LiveSettleRequest } from './copy-live-settler.js';

export interface ApiSettlementWork {
  repository: CopyLiveApiSettlementRepository;
  settle(request: LiveSettleRequest): Promise<LiveSettleOutcome>;
  saveSettlement(key: string): Promise<boolean>;
}
/**
 * Whether this process runs the terminal settlement loop: only for a
 * testnet copy deployment, and then on the api unless
 * API_TERMINAL_SETTLEMENT=off, on a worker that runs copy work when
 * WORKER_TERMINAL_SETTLEMENT is on (a `copy` worker's default; `all` keeps
 * today's off). Claims are fenced in the database
 * (CopyLiveSettlementClaims), so the api and the copy worker may both run
 * it during the cutover (design §2.3, Phase 1a-4).
 */
export function terminalSettlementRuns(config: AppConfig): boolean {
  const c = config.value;
  if (c.copy.live?.network !== 'testnet' || c.hyperliquid.wallet.network !== 'testnet') return false;
  return c.app.isWorker ? c.app.terminalSettlement?.worker === true : c.app.terminalSettlement?.api !== false;
}

/** The API's only copy background exception: terminal testnet settlement,
 * which the copy worker can run instead (terminalSettlementRuns).
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
    if (this.config.value.app.nodeEnv === 'test' || !terminalSettlementRuns(this.config)) return;
    this.logger.log(`Terminal settlement loop on the ${this.config.value.app.isWorker ? 'worker' : 'api'} every 3 s`);
    this.timer = setInterval(() => { void this.tick(); }, 3000); this.timer.unref?.();
  }
  onModuleDestroy(): void { this.stopped = true; this.shutdown.abort(); clearInterval(this.timer); }
  async tick(): Promise<void> {
    if (this.running || this.stopped || this.jobs.stopping || !terminalSettlementRuns(this.config)) return;
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
          }, AbortSignal.any([this.jobs.signal, this.shutdown.signal])); } catch (error) { this.logger.warn(`Terminal settlement ${key} pending; durable journal retained ${JSON.stringify(errorLogFields(error))}`); }
        }
      });
    } catch (error) { this.logger.warn(`Terminal settlement admission pending ${JSON.stringify(errorLogFields(error))}`); }
    finally { this.running = false; }
  }
}
