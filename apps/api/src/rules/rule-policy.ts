import { type alertRules } from "@trading-dashboard/shared/database";
import { flatOrPctParamsSchema } from "@trading-dashboard/shared/contracts";
import type { ActionCreatedEvent } from "../watcher/action-created.event.js";
/** Pure rule policy; callers own recipients, transactions, cooldowns and delivery. */
export function ruleMatches(rule: typeof alertRules.$inferSelect, action: ActionCreatedEvent, equityUsd: number | null): boolean {
  if (rule.kind === "R2") return action.kind === "flip";
  if (rule.kind !== "R1" && rule.kind !== "R3") return false;
  if (rule.kind === "R1" && action.kind !== "open") return false;
  const params = flatOrPctParamsSchema.parse(rule.paramsJson);
  const threshold = equityUsd === null ? params.flatThresholdUsd : Math.min(params.flatThresholdUsd, equityUsd * params.pctThreshold);
  return Number(action.notionalUsd) >= threshold;
}
