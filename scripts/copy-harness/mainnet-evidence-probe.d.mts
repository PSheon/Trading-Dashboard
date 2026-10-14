// Types for the spec's import of mainnet-evidence-probe.mjs (the report and the observation diff).
export function renderReport(result: unknown): string;
export interface ObservationDiff { read: string; account: string; scope: 'account-independent' | 'account-specific'; answers: number; paths: string[] | null }
export function observationDiffs(answers: readonly { type: string; account: string; value: unknown }[], changedReads: readonly string[]): ObservationDiff[];
