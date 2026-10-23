/**
 * Which Hyperliquid meter a process charges (decision D12, 2026-10-23;
 * docs/railway-deploy.md "Read worker meter"). Hyperliquid limits REST
 * weight per public IP; each Railway service has its own, so the processes
 * that share an IP must share a meter row (`hyperliquid_egress_quota`, keyed
 * by egress key) and those that do not must not.
 *
 * - `copy`: the copy side — the api and the copy worker — on the shared
 *   meter `HYPERLIQUID_EGRESS_KEY` (its testnet host `<key>:testnet`), with
 *   live copying first, as before D12.
 * - `read`: the read worker (WORKER_ROLE=read, HYPERLIQUID_READ_METER=own,
 *   the default) on its own meter `<key>:read` (testnet `<key>:read:testnet`),
 *   background capped at READ_WORKER_BACKGROUND_REST_CAP.
 *
 * The key is derived from the shared one, never a second variable: the two
 * can not drift apart, and `HYPERLIQUID_READ_METER=shared` on worker-read
 * puts it back on the shared meter (the rollback if Hyperliquid turns out to
 * count both IPs together). A process charges only its own meter's keys
 * (PostgresHyperliquidQuota refuses the other's: `hyperliquid_quota_meter_foreign`).
 */
export type HyperliquidMeter = 'copy' | 'read';
export const HYPERLIQUID_METERS: readonly HyperliquidMeter[] = ['copy', 'read'];
/** The key segment that marks the read worker's meter. */
const READ_SEGMENT = 'read';
const READ_SEGMENT_PATTERN = /(^|:)read(:|$)/;
/** The read worker's own meter key from the deployment's shared key. */
export function readMeterKey(sharedEgressKey: string): string { return `${sharedEgressKey}:${READ_SEGMENT}`; }
/** Whether `egressKey` carries the read segment (`<key>:read`, `<key>:read:testnet`). */
export function isReadMeterKey(egressKey: string): boolean { return READ_SEGMENT_PATTERN.test(egressKey); }
/** The meter an egress key belongs to. */
export function meterOf(egressKey: string): HyperliquidMeter { return isReadMeterKey(egressKey) ? 'read' : 'copy'; }
