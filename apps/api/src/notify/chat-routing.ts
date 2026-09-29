import type { AlertRuleKind } from "@trading-dashboard/shared";

import { env } from "../config/env.js";

/** §4.4 N1: R1–R5 -> realtime chat, R6–R9 -> group chat. R4–R9 don't exist
 * as rules yet in M2 (RulesService never evaluates/fires them), but the
 * routing function already switches correctly for when they do — no
 * one-line-change surprise later. Shared by RulesService (to group
 * simultaneously-firing rules by destination before notifying, so one
 * action never sends two Telegram messages) and NotifyService (to pick the
 * actual chat id to send to). */
const GROUP_KINDS: AlertRuleKind[] = ["R6", "R7", "R8", "R9"];

export function chatIdForRuleKind(kind: AlertRuleKind): string | undefined {
  return GROUP_KINDS.includes(kind) ? env.telegramChatIdGroup() : env.telegramChatIdRealtime();
}
