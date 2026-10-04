import { hasPermission } from "./permissions.js";
import type { RequestUser } from "./current-user.js";

/** Whose alerts a caller may read: everyone's (`"all"`), one user's, or
 * none (anonymous). Alerts carry the recipient's Telegram chat id and
 * message, so they are private to that recipient. */
export type AlertsScope = "all" | { userId: number } | "none";

export function alertsVisibleTo(user: RequestUser | null): AlertsScope {
  if (!user) return "none";
  if (hasPermission(user, "alerts.readAll")) return "all";
  if (user.kind === "service") return "none";
  return { userId: user.id };
}


/** Fields of an alert's payload that identify its recipient on Telegram. */
const RECIPIENT_FIELDS = ["chatId"] as const;

/**
 * An alert as `user` may see it: their own in full; anyone else's (read
 * with `alerts.readAll`: an operator, an admin, the service token) without
 * the recipient's Telegram chat id. The message, its values and the
 * delivery outcome stay.
 */
export function redactAlerts<T extends { userId?: number | null; payloadJson: Record<string, unknown> }>(entries: T[], user: RequestUser | null): T[] {
  const viewer = user?.kind === "user" ? user.id : null;
  return entries.map((entry) => {
    if (entry.userId != null && entry.userId === viewer) return entry;
    if (!RECIPIENT_FIELDS.some((field) => field in entry.payloadJson)) return entry;
    const payloadJson = { ...entry.payloadJson };
    for (const field of RECIPIENT_FIELDS) delete payloadJson[field];
    return { ...entry, payloadJson };
  });
}
