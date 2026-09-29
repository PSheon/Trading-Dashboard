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

