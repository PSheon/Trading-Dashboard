import { adminAuditLogs } from "@trading-dashboard/shared/database";
import type { DbTransaction } from "../../db/unit-of-work.js";
import type { RequestUser } from "../auth/current-user.js";

export type AuditActor = RequestUser | number | null;
/** Records only caller-selected policy fields, never headers/tokens or full
 * request bodies. Await inside the business transaction; failures roll it back. */
export async function recordAdminAudit(tx: DbTransaction, actor: AuditActor,
  event: "job.retry" | "user.update" | "user.delete" | "user.bootstrap" | "settings.update" | "rule.create" | "rule.update" | "leader.update" | "list.import" | "kol.upsert" | "kol.delete" | "kol.import" | "copy.control" | "copy.risk" | "retention.run",
  target: string, before: unknown, after: unknown) {
  const actorKind = typeof actor === "number" || actor?.kind === "user" ? "user" : actor?.kind === "service" ? "service" : "system";
  const actorUserId = typeof actor === "number" ? actor : actor?.kind === "user" ? actor.id : null;
  const json = (value: unknown) => value === undefined ? null : JSON.parse(JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item));
  await tx.insert(adminAuditLogs).values({ actorKind, actorUserId, event, target, beforeJson: json(before), afterJson: json(after) });
}
