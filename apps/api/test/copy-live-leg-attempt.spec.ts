import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { copyLiveIntentProvenance } from '@trading-dashboard/shared/database';
import { describe, expect, it } from 'vitest';
import { liveSourceExecutionAttempt, liveSourceExecutionCloid, MAX_LIVE_LEG_ATTEMPTS } from '../src/copy/live/copy-live-leg-attempt.js';

/** The database's bound on copy_live_intent_provenance.attempt (0082) is MAX_LIVE_LEG_ATTEMPTS. */
describe('the leg attempt bound', () => {
  const upper = (expression: string) => {
    const match = /"attempt" >= 0 and .*"attempt" < (\d+)$/.exec(expression.trim());
    expect(match).not.toBeNull();
    return Number(match![1]);
  };
  it('the schema check and migration 0082 bound the attempt column at MAX_LIVE_LEG_ATTEMPTS', () => {
    const check = getTableConfig(copyLiveIntentProvenance).checks.find(c => c.name === 'copy_live_provenance_attempt_check');
    expect(check).toBeDefined();
    expect(upper(new PgDialect().sqlToQuery(check!.value).sql)).toBe(MAX_LIVE_LEG_ATTEMPTS);
    const migration = readFileSync(fileURLToPath(new URL('../../../packages/shared/drizzle/0082_copy_live_provenance_attempt.sql', import.meta.url)), 'utf8');
    const added = /ADD CONSTRAINT "copy_live_provenance_attempt_check" CHECK \((.*)\);?\s*$/m.exec(migration);
    expect(added).not.toBeNull();
    expect(upper(added![1]!)).toBe(MAX_LIVE_LEG_ATTEMPTS);
    // The migration's backfill derives the same attempts the cloid does.
    for (let k = 1; k < MAX_LIVE_LEG_ATTEMPTS; k++) expect(migration).toContain(`(${k})`);
    expect(migration).not.toContain(`(${MAX_LIVE_LEG_ATTEMPTS})`);
  });
  it('every attempt below the bound has its own cloid, and none past it', () => {
    const cloids = Array.from({ length: MAX_LIVE_LEG_ATTEMPTS }, (_, k) => liveSourceExecutionCloid('mandate', 'fill', 'open', k));
    expect(new Set(cloids).size).toBe(MAX_LIVE_LEG_ATTEMPTS);
    cloids.forEach((cloid, k) => expect(liveSourceExecutionAttempt('mandate', 'fill', 'open', cloid)).toBe(k));
    expect(() => liveSourceExecutionCloid('mandate', 'fill', 'open', MAX_LIVE_LEG_ATTEMPTS)).toThrow('live_leg_attempt_invalid');
  });
});
