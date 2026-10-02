/** Domain constants shared by persistence and transport without importing an ORM. */
export const CHAIN_DEFAULT = "hyperliquid" as const;
export const tierEnum = ["A", "B", "C"] as const;
/** Why an address is watched: imported by an admin, favorited by a user, or copied by a user (Stage 4 paper copy). */
export const leaderSourceEnum = ["import", "favorite", "copy"] as const;
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
/** operator: the read-only operations role (every *.read grant, no write; review finding 14). */
export const userRoleEnum = ["user", "operator", "admin"] as const;
/** UI languages, in CopyDog's menu order. Stored as text (users.locale): adding one needs no migration. */
export const localeEnum = ["en", "zh-TW", "zh-CN", "ko", "ja", "ru", "tr", "vi", "es", "pt", "id"] as const;
export const alertSidesEnum = ["buy", "sell", "both"] as const;
export const notificationChannelKindEnum = ["telegram"] as const;
export const traderWindowEnum = ["day", "week", "month", "allTime"] as const;
export const appSettingsKeyEnum = ["general", "discovery", "notifications", "revenue"] as const;
// --- copy trading (Stage 4 step 3: paper mode) ------------------------------
/** Deployment capability, from COPY_TRADING_MODE. Only disabled and paper exist in this build. */
export const copyTradingModeEnum = ["disabled", "paper", "testnet", "live"] as const;
/** CopyDog's `copy_direction`: same side as the leader (順向) or the opposite (反向). */
export const copyDirectionEnum = ["same", "reverse"] as const;
/** CopyDog's `allocation_mode`: ratio (Hyperliquid default) or a fixed USDC notional per trade. */
export const copySizingModeEnum = ["ratio", "fixed"] as const;
/** CopyDog's `copy_start_mode`: adopt = also mirror the leader's current positions (跟單目前持倉 on). */
export const copyStartModeEnum = ["adopt", "delta"] as const;
export const copyStrategyStatusEnum = ["active", "paused", "stopping", "stopped"] as const;
/** Order state machine. `submitted` and `unknown` are reserved for testnet/live (an exchange round trip). */
export const copyOrderStatusEnum = ["intent", "risk_approved", "submitting", "submitted", "unknown", "partial", "filled", "rejected", "cancelled"] as const;
/** open: risk-increasing leg of a leader fill; close: reduce-only leg; adopt: mirror of a position held at activation; stop_close: from a close_positions / stop command. */
export const copyLegEnum = ["open", "close", "adopt", "stop_close"] as const;
export const copyControlCommandEnum = ["pause_new_risk", "cancel_pending", "reduce_only", "close_positions", "resume"] as const;
export const copyControlScopeEnum = ["platform", "user", "strategy"] as const;
export type CopyTradingMode = (typeof copyTradingModeEnum)[number];
export type CopyDirection = (typeof copyDirectionEnum)[number];
export type CopySizingMode = (typeof copySizingModeEnum)[number];
export type CopyStartMode = (typeof copyStartModeEnum)[number];
export type CopyStrategyStatus = (typeof copyStrategyStatusEnum)[number];
export type CopyOrderStatus = (typeof copyOrderStatusEnum)[number];
export type CopyLeg = (typeof copyLegEnum)[number];
export type CopyControlCommand = (typeof copyControlCommandEnum)[number];
export type CopyControlScope = (typeof copyControlScopeEnum)[number];
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
