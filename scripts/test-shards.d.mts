// Types for apps/api/vitest.config.ts, which imports test-shards.mjs.
export const SUITES: Record<'api' | 'e2e', { durations: string; dir?: string }>;
export function loadDurations(suite: 'api' | 'e2e'): Record<string, number>;
export function parseShard(value: string | undefined): { index: number; count: number };
export function partition(files: string[], durations: Record<string, number>, count: number): { files: string[]; seconds: number }[];
export function e2eFiles(dir?: string): string[];
export function parseLogs(text: string): { api: Record<string, number>; e2e: Record<string, number> };
