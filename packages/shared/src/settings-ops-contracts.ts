import { z } from "zod";
import { isoDatetimeOffsetSchema } from "./primitives.js";

export const appliedDiscoverySchema = z.object({
  consumer: z.enum(["pool", "leaderboard"]), revision: z.string().regex(/^[a-f0-9]{64}$/),
  checkedAt: isoDatetimeOffsetSchema, recovered: z.boolean(),
  candidatePoolSize: z.number(), poolWeightPerMinute: z.number(), poolPerformanceWeightPerMinute: z.number().optional(), leaderboardRefreshMinutes: z.number(),
});
export type AppliedDiscovery = z.infer<typeof appliedDiscoverySchema>;
/** The deploy-time tuning a process runs with (DISCOVERY_*, the
 * HYPERLIQUID_*_WEIGHT_PER_MIN loop caps, RETENTION_*): read at startup,
 * shown read-only in the admin. */
const count = z.number().int().nonnegative();
export const deploymentTuningSchema = z.object({
  discovery: z.object({ leaderboardRefreshMinutes: count, candidatePoolSize: count, cohortMembersPerTier: count, cohortRefreshMinutes: count }),
  weights: z.object({ poolLedger: count, poolPerformance: count, history: count, backfill: count, cohort: count }),
  retention: z.object({ enabled: z.boolean(), snapshotDays: count, auditDays: count, accountDeletionDays: count, queueDays: count, alertDays: count,
    // Optional while older workers roll out (2026-10-22).
    copyEquityFullDays: count.optional(), cohortMemberListDays: count.optional(), followerObservationDays: count.optional(), historyFillDays: count.optional() }),
});
export type DeploymentTuning = z.infer<typeof deploymentTuningSchema>;
export const settingsRuntimeSchema = z.object({
  savedRevision: z.string(), sampledAt: isoDatetimeOffsetSchema,
  state: z.enum(["active", "standby", "stopping", "stale", "unavailable", "not_configured"]),
  instanceId: z.string().nullable(), consumers: z.array(appliedDiscoverySchema),
});
export type SettingsRuntime = z.infer<typeof settingsRuntimeSchema>;
export const auditEvents = ["job.retry", "user.update", "user.delete", "user.bootstrap", "settings.update", "rule.create", "rule.update", "leader.update", "list.import", "kol.upsert", "kol.delete", "kol.import", "copy.control", "copy.risk", "copy.grant.revoke", "retention.run", "wallet.withdrawal.resolve", "copy.funding.resolve"] as const;
const auditId = z.string().regex(/^[1-9]\d{0,18}$/).refine(v => BigInt(v) <= 9223372036854775807n);
export const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25), beforeId: auditId.optional(),
  event: z.enum(auditEvents).optional(), actorKind: z.enum(["user", "service", "system"]).optional(),
  actorUserId: z.coerce.number().int().min(1).max(2147483647).optional(),
  target: z.string().min(1).max(256).optional(),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;
export const auditEntrySchema = z.object({
  id: auditId, actorKind: z.enum(["user", "service", "system"]), actorUserId: z.number().int().nullable(),
  event: z.string(), target: z.string(), before: z.unknown().nullable(), after: z.unknown().nullable(),
  createdAt: isoDatetimeOffsetSchema,
});
export const auditResponseSchema = z.object({ items: z.array(auditEntrySchema), nextCursor: auditId.nullable() });
export type AuditResponse = z.infer<typeof auditResponseSchema>;
