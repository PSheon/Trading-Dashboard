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
 * Above it the comparison still fails (closed), and the skew monitor warns
 * from 1 s on, before it matters.
 */
export const PROVIDER_CLOCK_SKEW_MS = 2000;
/** The monitor warns when the measured skew is larger than this. */
export const CLOCK_SKEW_WARN_MS = 1000;

/** Whether provider time `at` is not after `now` on our clock, within the tolerance. */
export function providerTimeNotAfter(at: number, now: number): boolean {
  return Number.isSafeInteger(at) && Number.isSafeInteger(now) && at <= now + PROVIDER_CLOCK_SKEW_MS;
}

/**
 * Our clock against Hyperliquid's, from provider times read on the worker
 * (account state `time`): each sample is our clock when the answer arrived
 * minus the provider's time in it, so it also carries the network latency
 * (always positive). The smallest of the recent samples is the closest to
 * the true offset: positive, our clock runs ahead; negative, behind.
 */
export class ClockSkewMonitor {
  private samples: { at: number; aheadMs: number }[] = [];
  private warnedAt = -Infinity;
  constructor(private readonly windowMs = 5 * 60_000, private readonly log: (message: string) => void = message => new Logger('ClockSkew').warn(message)) {}

  observe(providerTime: number, localTime: number): void {
    if (!Number.isSafeInteger(providerTime) || !Number.isSafeInteger(localTime) || providerTime <= 0) return;
    this.samples.push({ at: localTime, aheadMs: localTime - providerTime });
    this.samples = this.samples.filter(s => localTime - s.at <= this.windowMs).slice(-64);
    const ahead = this.aheadMs();
    if (ahead !== null && Math.abs(ahead) > CLOCK_SKEW_WARN_MS && localTime - this.warnedAt >= 60_000) {
      this.warnedAt = localTime;
      this.log(`WARN clock skew: our clock runs ${ahead > 0 ? 'ahead of' : 'behind'} Hyperliquid by about ${Math.abs(ahead)} ms ` +
        `(tolerance ${PROVIDER_CLOCK_SKEW_MS} ms); sync the host clock`);
    }
  }
  /** The recent smallest (our clock − provider time), or null without samples. */
  aheadMs(): number | null {
    return this.samples.length ? Math.min(...this.samples.map(s => s.aheadMs)) : null;
  }
  status(): { aheadMs: number | null; samples: number; warning: boolean } {
    const ahead = this.aheadMs();
    return { aheadMs: ahead, samples: this.samples.length, warning: ahead !== null && Math.abs(ahead) > CLOCK_SKEW_WARN_MS };
  }
}

/** The process's monitor: the account observer feeds it, the fast source and the heartbeat read it. */
export const clockSkew = new ClockSkewMonitor();
