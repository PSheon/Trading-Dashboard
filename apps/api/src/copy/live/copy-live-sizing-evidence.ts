import type { LiveMarketIdentity } from './live-market-resolver.js';
import type { LiveAccountSnapshot } from './live-account-observer.js';
import type { LiveRiskProviderProof } from './live-risk-provider.js';
import type { LiveGenerationManifestV1 } from './copy-live-generation-projection.js';

/** Immutable V1 inputs. Digests refer to original actual-network observations;
 * a trusted scoped producer must supply and verify those original observations.
 * A budget is an owner risk cap and is never account-equity evidence. */
export interface LiveSourceSizingBasisV1 {
  readonly version: 1;
  readonly mandateId: string;
  readonly mandateRevision: number;
  readonly settingsDigest: string;
  readonly sourceFillId: string;
  readonly sourceDigest: string;
  readonly network: 'testnet';
  readonly accountAddress: string;
  readonly coin: string;
  readonly leg: 'open' | 'close';
  readonly direction: 'same' | 'reverse';
  readonly sizingMode: 'ratio' | 'fixed';
  readonly budgetUsd: string;
  readonly perTradeUsd: string | null;
  readonly market: LiveMarketIdentity;
  readonly quote: {
    readonly midPrice: string;
    readonly slippageBps: string;
    readonly observedAt: number;
    readonly completedAt: number;
    readonly sourceDigest: string;
  };
  readonly follower: {
    readonly network: 'testnet';
    readonly accountAddress: string;
    readonly equity: string;
    readonly positionSize: string;
    readonly observedAt: number;
    readonly completedAt: number;
    readonly sourceDigest: string;
    readonly snapshotDigest: string;
    readonly positionsDigest: string;
  };
  readonly leader: {
    readonly network: 'testnet';
    readonly accountAddress: string;
    readonly equity: string;
    readonly observedAt: number;
    readonly completedAt: number;
    readonly sourceDigest: string;
    readonly snapshotDigest: string;
  } | null;
  readonly generation: {
    readonly mandateId: string;
    readonly baselineDigest: string;
    readonly receiptManifestDigest: string;
    readonly positionsDigest: string;
    readonly positionSize: string;
  };
  readonly carry: { readonly amount: string; readonly revision: number };
  /** Present only for an opening leg of a testnet copy that follows a MAINNET
   * leader: the leader's whole-account value (the ratio denominator, as paper
   * sizing uses) and the coin's mainnet mid, read on mainnet. The testnet mid
   * above prices the order; it must lie within `maxDeviationBps` of this mid
   * (testnet books can sit far from mainnet). Absent for a testnet source. */
  readonly sourceReference?: LiveSourceReferenceV1;
  /** This is verified against the original SQL claim, never a caller permit. */
  readonly fixedTradeClaim: boolean;
  /** A flip open requires the actual close's immutable settlement certificate. */
  readonly settledDependency: { readonly legId: string; readonly certificateDigest: string } | null;
  /** Present for ONE follower adjustment made of several same-coin leader
   * legs (ratio sizing): every leg, this order's own (`sourceFillId`)
   * included, in leader-time order. An open is sized by their summed leader
   * notional; a close by the combined fraction 1 − Π(1 − fraction). */
  readonly merged?: LiveMergedLegsV1;
}

export interface LiveMergedLegV1 {
  readonly sourceFillId: string;
  readonly sourceDigest: string;
  readonly providerTime: number;
  readonly sign: 1 | -1;
  readonly size: string;
  readonly px: string;
  readonly fraction: string | null;
}
export interface LiveMergedLegsV1 { readonly members: readonly LiveMergedLegV1[] }

export interface LiveSourceReferenceV1 {
  readonly network: 'mainnet';
  readonly leaderAddress: string;
  /** Null for fixed sizing, which does not use the leader's capital. */
  readonly leaderEquity: string | null;
  readonly leaderEquityObservedAt: number | null;
  readonly midPrice: string;
  readonly midObservedAt: number;
  readonly maxDeviationBps: string;
}

export interface PlannedLiveSourceOrder {
  readonly plannerVersion: 1;
  readonly legId: string;
  readonly sourceDigest: string;
  readonly settingsDigest: string;
  readonly sizingBasis: LiveSourceSizingEnvelopeV1;
  readonly order: {
    readonly coin: string; readonly asset: number; readonly side: 'B' | 'A';
    readonly size: string; readonly limitPrice: string; readonly sizeDecimals: number;
    readonly reduceOnly: boolean; readonly timeInForce: 'Ioc';
  };
  readonly nextCarry: string;
  readonly fixedTradeClaim: boolean;
  readonly dependsOnLegId: string | null;
}

/** Persist the full original observations. Compact scalars alone prove nothing. */
export interface LiveSourceSizingEnvelopeV1 {
  readonly version: 1;
  readonly basis: LiveSourceSizingBasisV1;
  readonly observations: {
    readonly follower: LiveAccountSnapshot;
    readonly leader: LiveAccountSnapshot | null;
    readonly quote: LiveRiskProviderProof;
    readonly generationManifest: LiveGenerationManifestV1;
  };
}
