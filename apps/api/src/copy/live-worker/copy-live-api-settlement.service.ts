import { Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import type { AppConfig } from '../../config/app-config.js';
import type { BackgroundJobs } from '../../runtime/background-jobs.service.js';
import { errorLogFields } from '../../runtime/safe-error-text.js';
import { CopyLiveApiSettlementRepository } from './copy-live-api-settlement.repository.js';
import { CopyLiveSettlementClaims, type SettlementClaim } from './copy-live-settlement-claim.js';
import type { LiveQuarantineOutcome, LiveSettleOutcome, LiveSettleRequest } from './copy-live-settler.js';
import { SETTLEMENT_NEEDS_OWNER, SettlementRetries, type SettlementVerdict } from './settlement-retries.js';
import { SettlementPendingLog } from './settlement-pending-log.js';

interface ApiSettlementWork {
  repository: CopyLiveApiSettlementRepository;
  settle(request: LiveSettleRequest): Promise<LiveSettleOutcome>;
  /** Its retries are over: the order goes to its owner (CopyLiveSettler.quarantine). */
  quarantine(request: LiveSettleRequest, reason: string): Promise<LiveQuarantineOutcome>;
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
  /** Failed passes per order (SETTLEMENT_RETRY_POLICY): when the next is due, and when its retries are over. */
  private readonly retries: SettlementRetries;
  constructor(private readonly config: AppConfig, private readonly jobs: BackgroundJobs,
    private readonly candidates: CopyLiveApiSettlementRepository, private readonly claims: CopyLiveSettlementClaims,
    private readonly work: (claim: SettlementClaim) => ApiSettlementWork, now: () => number = Date.now) { this.retries = new SettlementRetries(now); }
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
          // A failed pass is not tried again before its retry is due (it claims live demand and opens sockets).
          if (!this.retries.due(key)) continue;
          try { await this.claims.run(key, async claim => {
            const w = this.work(claim);
            const loaded = await w.repository.load(key); claim.assertFresh();
            if (!loaded) return;
            let outcome: LiveSettleOutcome;
            if (this.retries.owed(key)) outcome = await this.toOwner(w, loaded.request, key, null);
            else {
              try { outcome = await w.settle(loaded.request); }
              catch (error) {
                const verdict = this.retries.failed(key, error);
                if (verdict.kind !== 'needs_owner') throw error;
                outcome = await this.toOwner(w, loaded.request, key, verdict);
              }
              const verdict = outcome.kind === 'pending' ? this.retries.outcome(key, outcome) : (this.retries.done(key), null);
              if (verdict?.kind === 'needs_owner') outcome = await this.toOwner(w, loaded.request, key, verdict);
            }
            this.pending.note(key, outcome); claim.assertFresh();
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
  /** Its retries are over: the order goes to its owner (quarantined, with an
   * ALERT naming the account's flat stop when there is one); its dispatch is
   * then refused (finish), so nothing settles it or claims live demand again. */
  private async toOwner(w: ApiSettlementWork, request: LiveSettleRequest, key: string, verdict: Extract<SettlementVerdict, { kind: 'needs_owner' }> | null): Promise<LiveSettleOutcome> {
    const outcome = await w.quarantine(request, SETTLEMENT_NEEDS_OWNER);
    if (outcome.kind === 'released') { this.retries.done(key); return outcome; }
    this.logger.error(`ALERT settlement_needs_owner ${JSON.stringify({ key, accountId: request.accountId, attempts: verdict?.attempts ?? null, lastCode: verdict?.code ?? null,
      reservation: outcome.reason, flatStop: outcome.flat ? { stopId: outcome.flat.stopId, flatDigest: outcome.flat.flatDigest, flatVerifiedAt: new Date(outcome.flat.flatVerifiedAt).toISOString() } : null })}`);
    this.retries.done(key);
    return { kind: 'quarantine', reason: SETTLEMENT_NEEDS_OWNER };
  }
}
