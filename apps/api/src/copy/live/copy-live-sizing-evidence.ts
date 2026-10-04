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
  /** This is verified against the original SQL claim, never a caller permit. */
  readonly fixedTradeClaim: boolean;
  /** A flip open requires the actual close's immutable settlement certificate. */
  readonly settledDependency: { readonly legId: string; readonly certificateDigest: string } | null;
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
