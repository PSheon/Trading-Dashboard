/** Domain constants shared by persistence and transport without importing an ORM. */
export const CHAIN_DEFAULT = "hyperliquid" as const;
export const tierEnum = ["A", "B", "C"] as const;
export const leaderSourceEnum = ["import", "favorite"] as const;
export const actionKindEnum = [
  "open",
  "add",
  "reduce",
  "close",
  "flip",
  "liquidation",
] as const;
export const alertRuleScopeEnum = ["address", "group"] as const;
export const alertRuleKindEnum = [
  "R1",
  "R2",
  "R3",
  "R4",
  "R5",
  "R6",
  "R7",
  "R8",
  "R9",
] as const;
export const sendStatusEnum = ["pending", "sent", "failed", "dry_run"] as const;
export const userRoleEnum = ["user", "admin"] as const;
/** UI languages, in CopyDog's menu order. Stored as text (users.locale): adding one needs no migration. */
export const localeEnum = ["en", "zh-TW", "zh-CN", "ko", "ja", "ru", "tr", "vi", "es", "pt", "id"] as const;
export const alertSidesEnum = ["buy", "sell", "both"] as const;
export const notificationChannelKindEnum = ["telegram"] as const;
export const traderWindowEnum = ["day", "week", "month", "allTime"] as const;
export const appSettingsKeyEnum = ["general", "discovery", "notifications", "revenue"] as const;
export type LeaderSource = (typeof leaderSourceEnum)[number];
export type Tier = (typeof tierEnum)[number];
export type ActionKind = (typeof actionKindEnum)[number];
export type AlertRuleScope = (typeof alertRuleScopeEnum)[number];
export type AlertRuleKind = (typeof alertRuleKindEnum)[number];
export type SendStatus = (typeof sendStatusEnum)[number];
export type UserRole = (typeof userRoleEnum)[number];
export type Locale = (typeof localeEnum)[number];
export type AlertSides = (typeof alertSidesEnum)[number];
export type NotificationChannelKind = (typeof notificationChannelKindEnum)[number];
export type TraderWindow = (typeof traderWindowEnum)[number];
export type AppSettingsKey = (typeof appSettingsKeyEnum)[number];
