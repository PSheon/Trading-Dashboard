import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  adminLiveOrdersQuerySchema, auditEntrySchema, isoDatetimeOffsetSchema, isoUtcSchema, kolPatchSchema, leaderDetailQuerySchema,
  patchAdminSettingsRequestSchema, prepareCopyAgentSchema, successEnvelopeSchema,
} from '@trading-dashboard/shared/contracts';
import { parseOr400 } from '../src/common/http/validation.js';

/** The zod 3 → 4 migration (2026-10-28) kept zod 3's parse results. Each case
 * here is one a plain zod 4 port would change. */
describe('zod 4 keeps zod 3 behaviour', () => {
  it('a settings PATCH of one field does not reset its siblings to their defaults', () => {
    // zod 4's `.partial()` fills an absent key from the field's `.default()`.
    expect(patchAdminSettingsRequestSchema.parse({ discovery: { hideVaults: false } })).toEqual({ discovery: { hideVaults: false } });
    expect(patchAdminSettingsRequestSchema.parse({ revenue: { builderFeeTenthsBps: 5 }, expectedRevisions: { revenue: 'a'.repeat(64) } }))
      .toEqual({ revenue: { builderFeeTenthsBps: 5 }, expectedRevisions: { revenue: 'a'.repeat(64) } });
    expect(kolPatchSchema.parse({ verified: true })).toEqual({ verified: true });
    expect(leaderDetailQuerySchema.parse({})).toEqual({});
  });

  it('records read a request DTO instance (zod 4 records refuse objects that are not plain)', () => {
    class RevisionsDto {}
    const expectedRevisions = Object.assign(new RevisionsDto(), { general: 'a'.repeat(64) });
    expect(patchAdminSettingsRequestSchema.parse({ general: { signupsOpen: true }, expectedRevisions }))
      .toEqual({ general: { signupsOpen: true }, expectedRevisions: { general: 'a'.repeat(64) } });
  });

  it('error bodies carry zod 3 messages at the same paths', () => {
    const fields = (schema: Parameters<typeof parseOr400>[0], value: unknown) => {
      try { parseOr400(schema, value); } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        return ((error as BadRequestException).getResponse() as { issues: unknown[] }).issues;
      }
      throw new Error('expected a 400');
    };
    expect(fields(prepareCopyAgentSchema, { validForDays: 1.5, extra: 1 })).toEqual([
      { path: 'idempotencyKey', message: 'Required' },
      { path: 'validForDays', message: 'Expected integer, received float' },
      { path: '', message: "Unrecognized key(s) in object: 'extra'" },
    ]);
    expect(fields(prepareCopyAgentSchema, { idempotencyKey: '', validForDays: 31 })).toEqual([
      { path: 'idempotencyKey', message: 'String must contain at least 1 character(s)' },
      { path: 'validForDays', message: 'Number must be less than or equal to 30' },
    ]);
    expect(fields(adminLiveOrdersQuerySchema, { state: 'x' })).toEqual([
      { path: 'state', message: "Invalid enum value. Expected 'open' | 'unknown' | 'all', received 'x'" },
    ]);
  });

  it('defaults still apply on parse', () => {
    expect(prepareCopyAgentSchema.parse({ idempotencyKey: 'k' })).toEqual({ idempotencyKey: 'k', validForDays: 7 });
    expect(adminLiveOrdersQuerySchema.parse({})).toEqual({ state: 'open' });
  });

  it('keys typed unknown stay optional, as zod 3 inferred them', () => {
    const meta = { requestId: 'r', path: '/x', timestamp: '2026-10-28T00:00:00.000Z' };
    expect(successEnvelopeSchema.parse({ success: true, statusCode: 200, message: 'OK', meta })).toEqual({ success: true, statusCode: 200, message: 'OK', meta });
    const entry = { id: '1', actorKind: 'system', actorUserId: null, event: 'e', target: 't', createdAt: '2026-10-28T00:00:00Z' };
    expect(auditEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('ISO instants keep zod 3 datetime acceptance', () => {
    // zod 4's own datetime requires seconds and a colon in the offset.
    expect(isoUtcSchema.safeParse('2026-10-28T12:00Z').success).toBe(true);
    expect(isoDatetimeOffsetSchema.safeParse('2026-10-28T12:00:00+0800').success).toBe(true);
    expect(isoUtcSchema.safeParse('2026-10-28T12:00:00+08:00').success).toBe(false);
    expect(isoUtcSchema.safeParse('2026-10-28').error?.issues[0]?.message).toBe('Invalid datetime');
  });
});
