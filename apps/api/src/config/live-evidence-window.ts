import type { HyperliquidNetwork } from '@trading-dashboard/shared/contracts';
import { INDEX_LAG_MS } from './constants/background.js';
import { LIVE_EVIDENCE_MAX_AGE_MS, LIVE_TESTNET_EVIDENCE_MAX_AGE_CAP_MS, SNAPSHOT_CHECK_MARGIN_MS } from './constants/timings.js';

/**
 * The evidence window of the live copy path: how old exchange evidence
 * (positions, orders, a mode, an approval) may be when a decision rests on it.
 *
 * Mainnet is always LIVE_EVIDENCE_MAX_AGE_MS (5 s). A testnet deployment may
 * widen it with COPY_LIVE_TESTNET_EVIDENCE_MAX_AGE_MS (5000..10000): testnet
 * lists 273 perp dexes and its fan-out alone took 1.5–1.6 s (gate 11,
 * 2026-10-16), so every order evidence read (4.7–5.1 s) was refused. Startup
 * refuses the setting when the execution network (HYPERLIQUID_NETWORK, where
 * orders go) is mainnet, and so does registration here.
 *
 * Every bound on the live and setup paths that means this window reads it
 * from here, never the constant: one resolver, per network.
 */
let testnetWindowMs = LIVE_EVIDENCE_MAX_AGE_MS;

/** Registered at boot (RuntimeConfigModule) from the validated config. */
export function registerLiveEvidenceWindow(network: HyperliquidNetwork, testnetMaxAgeMs: number | undefined): void {
  if (network !== 'mainnet' && network !== 'testnet') throw new Error('live evidence window: unknown network');
  if (testnetMaxAgeMs !== undefined && network !== 'testnet')
    throw new Error('COPY_LIVE_TESTNET_EVIDENCE_MAX_AGE_MS is testnet only: the execution network is mainnet, whose evidence window is always 5000 ms');
  if (testnetMaxAgeMs !== undefined && (!Number.isSafeInteger(testnetMaxAgeMs) || testnetMaxAgeMs < LIVE_EVIDENCE_MAX_AGE_MS || testnetMaxAgeMs > LIVE_TESTNET_EVIDENCE_MAX_AGE_CAP_MS))
    throw new Error(`COPY_LIVE_TESTNET_EVIDENCE_MAX_AGE_MS must be an integer between ${LIVE_EVIDENCE_MAX_AGE_MS} and ${LIVE_TESTNET_EVIDENCE_MAX_AGE_CAP_MS}`);
  testnetWindowMs = network === 'testnet' ? testnetMaxAgeMs ?? LIVE_EVIDENCE_MAX_AGE_MS : LIVE_EVIDENCE_MAX_AGE_MS;
}

/** The evidence window for evidence read on `network`; none: this
 * deployment's execution network (a mainnet deployment never registers more
 * than LIVE_EVIDENCE_MAX_AGE_MS). Mainnet evidence: always LIVE_EVIDENCE_MAX_AGE_MS. */
export function liveEvidenceMaxAgeMs(network?: HyperliquidNetwork): number {
  return network === 'mainnet' ? LIVE_EVIDENCE_MAX_AGE_MS : testnetWindowMs;
}

/** How old a close's held snapshot may be under the window in force,
 * with SNAPSHOT_CHECK_MARGIN_MS left for its own checks. */
export function liveSnapshotMaxAgeMs(network?: HyperliquidNetwork): number {
  return liveEvidenceMaxAgeMs(network) - SNAPSHOT_CHECK_MARGIN_MS;
}

/** LIVE_FILL_SCAN_MARGIN_MS under the window in force: INDEX_LAG_MS plus how
 * far our clock may run ahead of the exchange's, as far as the certificate's
 * own account snapshot (the evidence window) allows. */
export function liveFillScanMarginMs(network?: HyperliquidNetwork): number {
  return INDEX_LAG_MS + liveEvidenceMaxAgeMs(network);
}
