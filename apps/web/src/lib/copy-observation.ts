import type { CopyFollowerSnapshotRead } from '@trading-dashboard/shared/contracts';

/** An observation the api calls current. A stale one (its last read failed
 * or aged out) is still shown with its time, never as a current balance:
 * no PnL, no total, no amount offered for a transfer. */
export function currentObservation(read: CopyFollowerSnapshotRead | null | undefined) {
  return read?.status === 'observed' && read.freshness !== 'stale' ? read : null;
}
