import { Logger } from '@nestjs/common';

/**
 * How far our clock and Hyperliquid's may disagree before a comparison of a
 * provider timestamp with our clock fails. Every such comparison names it:
 *
 * - a provider time "not after now" (account state `time`, a resting order's
 *   `timestamp`) may be up to this far ahead of our clock (ours runs behind);
 * - a follower fill's exchange `time` may be up to this far before the order
 *   journal's `createdAt` on our clock (ours runs ahead by more than the
 *   sign-to-send latency).
 *
 * Above it the comparison still fails (closed); the skew monitor warns from
 * 1 s on, before it matters, and alerts above it.
 */
export const PROVIDER_CLOCK_SKEW_MS = 2000;
/** The monitor warns when the measured skew is larger than this. */
export const CLOCK_SKEW_WARN_MS = 1000;

/** Whether provider time `at` is not after `now` on our clock, within the tolerance. */
export function providerTimeNotAfter(at: number, now: number): boolean {
  return Number.isSafeInteger(at) && Number.isSafeInteger(now) && at <= now + PROVIDER_CLOCK_SKEW_MS;
}

/** The skew estimate is the median of at most this many recent samples. */
export const CLOCK_SKEW_SAMPLES = 15;

/**
 * Our clock against Hyperliquid's, from provider times read on the worker
 * (account state `time`): each sample is our clock when the answer arrived
 * minus the provider's time in it, so it also carries the network latency
 * (positive). The estimate is the median of the last CLOCK_SKEW_SAMPLES
 * samples within the window: one odd answer (a stale cached state, a time
 * stamped far off) moves it by at most one rank, where the smallest sample
 * followed it. Positive, our clock runs ahead; negative, behind. It carries
 * the median latency, so the fast source, which moves its bound back by it,
 * certifies at most that much less, never more.
 *
 * Logs a WARN (once a minute) above CLOCK_SKEW_WARN_MS and an ALERT (once a
 * minute) above PROVIDER_CLOCK_SKEW_MS, where comparisons start to fail.
 */
export class ClockSkewMonitor {
  private samples: { at: number; aheadMs: number }[] = [];
  private warnedAt = -Infinity;
  private alertedAt = -Infinity;
  constructor(private readonly windowMs = 3 * 60_000,
    private readonly log: (message: string) => void = message => {
      const logger = new Logger('ClockSkew');
      if (message.startsWith('ALERT')) logger.error(message); else logger.warn(message);
    }) {}

  observe(providerTime: number, localTime: number): void {
    if (!Number.isSafeInteger(providerTime) || !Number.isSafeInteger(localTime) || providerTime <= 0) return;
    this.samples.push({ at: localTime, aheadMs: localTime - providerTime });
    this.samples = this.samples.filter(s => localTime - s.at <= this.windowMs).slice(-CLOCK_SKEW_SAMPLES);
    const ahead = this.aheadMs();
    if (ahead === null) return;
    const how = `our clock runs ${ahead > 0 ? 'ahead of' : 'behind'} Hyperliquid by about ${Math.abs(ahead)} ms (median of ${this.samples.length} samples)`;
    if (Math.abs(ahead) > PROVIDER_CLOCK_SKEW_MS) {
      if (localTime - this.alertedAt >= 60_000) {
        this.alertedAt = localTime;
        this.log(`ALERT clock skew: ${how}, beyond the tolerance of ${PROVIDER_CLOCK_SKEW_MS} ms: ` +
          'provider times are refused and fills may be quarantined; sync the host clock now');
      }
    } else if (Math.abs(ahead) > CLOCK_SKEW_WARN_MS && localTime - this.warnedAt >= 60_000) {
      this.warnedAt = localTime;
      this.log(`WARN clock skew: ${how} (tolerance ${PROVIDER_CLOCK_SKEW_MS} ms); sync the host clock`);
    }
  }
  /** The median recent (our clock − provider time), or null without samples. */
  aheadMs(): number | null {
    if (!this.samples.length) return null;
    const sorted = this.samples.map(s => s.aheadMs).sort((a, b) => a - b), mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
  }
  status(): { aheadMs: number | null; samples: number; warning: boolean } {
    const ahead = this.aheadMs();
    return { aheadMs: ahead, samples: this.samples.length, warning: ahead !== null && Math.abs(ahead) > CLOCK_SKEW_WARN_MS };
  }
}

/** The process's monitor: the account observer feeds it, the fast source and the heartbeat read it. */
export const clockSkew = new ClockSkewMonitor();
