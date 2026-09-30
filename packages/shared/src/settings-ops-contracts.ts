import { z } from "zod";

export const appliedDiscoverySchema = z.object({
  consumer: z.enum(["pool", "leaderboard"]), revision: z.string().regex(/^[a-f0-9]{64}$/),
  checkedAt: z.string().datetime({ offset: true }), recovered: z.boolean(),
  candidatePoolSize: z.number(), poolWeightPerMinute: z.number(), leaderboardRefreshMinutes: z.number(),
});
export type AppliedDiscovery = z.infer<typeof appliedDiscoverySchema>;
export const settingsRuntimeSchema = z.object({
  savedRevision: z.string(), sampledAt: z.string().datetime({ offset: true }),
  state: z.enum(["active", "standby", "stopping", "stale", "unavailable", "not_configured", "combined"]),
  instanceId: z.string().nullable(), consumers: z.array(appliedDiscoverySchema),
});
export type SettingsRuntime = z.infer<typeof settingsRuntimeSchema>;
export const auditEvents = ["job.retry", "user.update", "user.delete", "settings.update", "rule.create", "rule.update", "leader.update", "list.import", "kol.upsert", "kol.delete", "kol.import", "copy.control", "copy.risk"] as const;
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
  createdAt: z.string().datetime({ offset: true }),
});
export const auditResponseSchema = z.object({ items: z.array(auditEntrySchema), nextCursor: auditId.nullable() });
export type AuditResponse = z.infer<typeof auditResponseSchema>;
