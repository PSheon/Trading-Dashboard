import { ConflictException, Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { copyFollowerSnapshotReadSchema, type CopyFollowerSnapshotRead } from '@trading-dashboard/shared/contracts';
import { AppConfig } from '../config/app-config.js';
import { BackgroundJobs } from '../runtime/background-jobs.service.js';
import { mapLiveAccountView } from './live/live-account-view.js';
import type { LiveAccountSnapshot } from './live/live-account-observer.js';
import { LiveBoundaryError } from './live/wallet-authorization.js';
import { CopyFollowerSnapshotRepository, type FollowerSnapshotIssue } from './copy-follower-snapshot.repository.js';

export const FOLLOWER_SNAPSHOT_READER = Symbol('FOLLOWER_SNAPSHOT_READER');
export interface FollowerSnapshotReader { observe(accountAddress: string): Promise<LiveAccountSnapshot>; close?(): void }

/** Provider-free owner reads. Original evidence times survive every HTTP poll. */
@Injectable()
export class CopyFollowerSnapshotService {
  constructor(private readonly repository: CopyFollowerSnapshotRepository) {}
  async get(userId: number, accountId: string): Promise<CopyFollowerSnapshotRead> {
    const result = await this.repository.getOwned(userId, accountId);
    // Another network's account (history on this deployment) shows its last stored observation.
    if (result.account.network !== 'testnet' && result.account.network !== 'mainnet') throw new ConflictException('actual_snapshot_network_unsupported');
    const identity = { mode: 'actual' as const, network: result.account.network, accountId: result.account.id, strategyId: result.account.strategyId, accountAddress: result.account.address };
    if (!result.observation) return copyFollowerSnapshotReadSchema.parse({ ...identity, status: 'unavailable', observation: null, reason: result.job?.issue ?? 'not_observed' });
    try {
      const snapshot = result.observation.snapshot as unknown as LiveAccountSnapshot;
      if (snapshot.sourceDigest !== result.observation.sourceDigest || snapshot.observedAt !== result.observation.observedAt.getTime() ||
          snapshot.completedAt !== result.observation.completedAt.getTime() || snapshot.coverage.earliestProviderTime !== result.observation.earliestProviderTime.getTime())
        throw new LiveBoundaryError('follower_snapshot_invalid');
      const view = mapLiveAccountView(identity, snapshot, result.quarantine, Date.now(), 5000);
      return copyFollowerSnapshotReadSchema.parse({ ...view, ...(result.job?.issue ? { freshness: 'stale', lastReadIssue: result.job.issue } : {}) });
    } catch { return copyFollowerSnapshotReadSchema.parse({ ...identity, status: 'unavailable', observation: null, reason: 'invalid_evidence' }); }
  }
}

/** One globally admitted all-venue reporting read per minute across replicas.
 * It preserves real residual accounts and never signs, activates or transfers. */
@Injectable()
export class CopyFollowerSnapshotCollector implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CopyFollowerSnapshotCollector.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  constructor(private readonly repository: CopyFollowerSnapshotRepository,
    @Inject(FOLLOWER_SNAPSHOT_READER) private readonly reader: FollowerSnapshotReader,
    private readonly config: AppConfig, private readonly jobs: BackgroundJobs) {}
  onApplicationBootstrap(): void {
    if (this.config.value.app.nodeEnv === 'test') return;
    this.timer = setInterval(() => void this.tick(), 15000); this.timer.unref?.();
  }
  onModuleDestroy(): void { clearInterval(this.timer); this.reader.close?.(); }
  async runOnce(): Promise<void> {
    const claim = await this.repository.claim(); if (!claim) return;
    try {
      // A provider wait is never inside a SQL transaction.
      const snapshot = await this.reader.observe(claim.accountAddress);
      await this.repository.save(claim, snapshot);
    } catch (error) {
      const code = error instanceof LiveBoundaryError ? error.code : '';
      const issue: FollowerSnapshotIssue = code.includes('account_mode') || code.includes('unsupported_role') ? 'unsupported_mode'
        : code.includes('coverage') ? 'incomplete_coverage' : code === 'follower_snapshot_invalid' || code === 'follower_account_identity_changed' ? 'invalid_evidence' : 'source_unavailable';
      await this.repository.issue(claim, issue);
      this.logger.warn('Actual account observation unavailable; prior evidence retained');
    }
  }
  async tick(): Promise<void> {
    if (this.running || this.jobs.stopping) return;
    this.running = true;
    try { await this.jobs.run(() => this.runOnce()); }
    catch { this.logger.warn('Actual account observation acquisition pending'); }
    finally { this.running = false; }
  }
}
