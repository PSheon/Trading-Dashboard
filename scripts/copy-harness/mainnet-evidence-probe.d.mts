// Types for the spec's import of mainnet-evidence-probe.mjs (the report, the observation diff, the freshness checks).
export function renderReport(result: unknown): string;
export interface ObservationDiff { read: string; account: string; scope: 'account-independent' | 'account-specific'; answers: number; paths: string[] | null }
export function observationDiffs(answers: readonly { type: string; account: string; value: unknown }[], changedReads: readonly string[]): ObservationDiff[];
export function freshnessCallSite(stack: string | undefined, sourceLines: readonly string[]): string | null;
export type FreshnessReason = 'not_integer' | 'negative' | 'ahead_of_clock' | 'older_than_bound';
export function freshnessReason(check: { kind: 'fresh' | 'freshProvider'; at: number; now: number; maxAgeMs: number; skewMs: number }): FreshnessReason | null;
export interface FreshnessCheck { site: string; role: string; ageMs: number; ok: boolean }
export function freshnessTable(checks: readonly FreshnessCheck[]): { site: string; role: string; n: number; minAgeMs: number; maxAgeMs: number; refused: number }[];
export function stateTimeLags(data: unknown, receivedAt: number): { dexes: number; maxLagMs: number; maxLagDex: string; minLagMs: number; minLagDex: string } | null;
