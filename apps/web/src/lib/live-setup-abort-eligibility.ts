import type { CopyFunding, LiveCopySetupKind } from '@trading-dashboard/shared/contracts';

/** A start abort needs its original funding operation to resolve or return.
 * Edit and renewal cancel a pending generation without a deposit. Saved abort
 * progress is handled separately, even when its original binding is unknown. */
export function canRequestSetupAbort(setup: {
  kind: LiveCopySetupKind;
  funding?: CopyFunding | null;
  fundingStatus?: CopyFunding['status'] | null;
}): boolean {
  return setup.kind !== 'start' || setup.funding != null || setup.fundingStatus != null;
}
