import { Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import type { AppConfig } from '../../config/app-config.js';
import type { BackgroundJobs } from '../../runtime/background-jobs.service.js';
import { errorLogFields } from '../../runtime/safe-error-text.js';
import { CopyLiveApiSettlementRepository } from './copy-live-api-settlement.repository.js';
import { CopyLiveSettlementClaims, type SettlementClaim } from './copy-live-settlement-claim.js';
import type { LiveSettleOutcome, LiveSettleRequest } from './copy-live-settler.js';
import { SettlementPendingLog } from './settlement-pending-log.js';

interface ApiSettlementWork {
  repository: CopyLiveApiSettlementRepository;
  settle(request: LiveSettleRequest): Promise<LiveSettleOutcome>;
  saveSettlement(key: string): Promise<boolean>;
}
/** A terminal settlement loop exists only on a testnet copy deployment. */
export function terminalSettlementApplies(config: AppConfig): boolean {
  const c = config.value;
  return c.copy.live?.network === 'testnet' && c.hyperliquid.wallet.network === 'testnet';
}
/**
 * Whether this process runs the loop: the api unless API_TERMINAL_SETTLEMENT=off,
 * a worker when WORKER_TERMINAL_SETTLEMENT is on. Claims are fenced in the
 * database (CopyLiveSettlementClaims), so both may run it at once.
 */
export function terminalSettlementRuns(config: AppConfig): boolean {
  const c = config.value;
  if (!terminalSettlementApplies(config)) return false;
  return c.app.isWorker ? c.app.terminalSettlement?.worker === true : c.app.terminalSettlement?.api !== false;
}

/** Terminal testnet settlement loop (api or copy worker: terminalSettlementRuns).
 * No execution, signing, funding or source-ingestion capability is injected. */
export class CopyLiveApiSettlementService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('CopyLiveApiSettlement');
  private running = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private readonly shutdown = new AbortController();
  /** Why an order's settlement is still pending (rate-limited per order). */
  private readonly pending = new SettlementPendingLog(message => this.logger.warn(message));
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
            const outcome = await w.settle(loaded.request); this.pending.note(key, outcome); claim.assertFresh();
            // Save reporting before finishing the dispatch, so a crash leaves it submitted (replayable).
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
