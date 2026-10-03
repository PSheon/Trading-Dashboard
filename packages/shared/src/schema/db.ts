import {
  CHAIN_DEFAULT,
  type LeaderSource,
  type Tier,
  type ActionKind,
  type AlertRuleScope,
  type AlertRuleKind,
  type SendStatus,
  type UserRole,
  type Locale,
  type AlertSides,
  type NotificationChannelKind,
  type AppSettingsKey,
  type CopyControlCommand,
  type CopyControlScope,
  type CopyDirection,
  type CopyLeg,
  type CopyOrderStatus,
  type CopySizingMode,
  type CopyStartMode,
  type CopyStrategyStatus,
  actionKindEnum,
  alertRuleKindEnum,
  alertRuleScopeEnum,
  alertSidesEnum,
  appSettingsKeyEnum,
  copyControlCommandEnum,
  copyControlScopeEnum,
  copyLegEnum,
  copyOrderStatusEnum,
  copyStrategyStatusEnum,
  leaderSourceEnum,
  notificationChannelKindEnum,
  sendStatusEnum,
  tierEnum,
  userRoleEnum,
} from "../enums.js";
export * from "../enums.js";
/**
 * Drizzle ORM schema — single source of truth for the Postgres data model
 * defined in PRD §6 (資料模型).
 *
 * Rules followed from the PRD:
 * - Every core table carries a `chain` column, always `'hyperliquid'` for v1
 *   (§11 決策紀錄: "chain 欄位 — 第 1 版即加，但不做任何抽象層").
 * - `fills` keeps a `raw jsonb` column to allow re-deriving data if the
 *   Hyperliquid schema changes (§11: "fills 原始資料").
 * - `fills` primary key is (chain, address, tid): §6 said (chain, tid), but
 *   both counterparties of a trade share one tid (see the table below).
 * - Primary keys / columns are taken verbatim from the §6 table; where the
 *   PRD is silent on a concrete SQL type (e.g. the bare "id" columns), an
 *   idiomatic Postgres choice is made (serial/bigserial + timestamptz).
 */

import {
  bigint,
  bigserial,
  check,
  customType,
  foreignKey,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/**
 * CHECK constraints (review finding 10). The text columns below are typed
 * with `.$type<>()`, which only TypeScript sees; these make Postgres refuse
 * a value the code would not understand, and a size, balance or fee the
 * code assumes can't be negative. `oneOf` renders `col in ('a', 'b')` from
 * the same shared enum the type comes from, so the two can't drift apart
 * without a migration. Deliberately unconstrained: `users.locale` (a new
 * language needs no migration), values Hyperliquid defines and may extend
 * (`fills.dir`, `position_snapshots.margin_mode`), free-text reasons and
 * outcomes, and `copy_strategies.cash`, which may be below zero while a
 * position's unrealized gain keeps the equity positive.
 */
const oneOf = (column: AnyPgColumn, values: readonly string[]): SQL =>
  sql`${column} in (${sql.raw(values.map((v) => `'${v.replaceAll("'", "''")}'`).join(", "))})`;

/** All core tables are chain-scoped; v1 only ever writes 'hyperliquid'. */

// ---------------------------------------------------------------------------
// leader_lists — 每次匯入一個版本
// ---------------------------------------------------------------------------
export const leaderLists = pgTable("leader_lists", {
  id: serial("id").primaryKey(),
  source: text("source").notNull(),
  importedAt: timestamp("imported_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  fileName: text("file_name").notNull(),
});

// ---------------------------------------------------------------------------
// leader_list_items — 名單版本內容，diff 用
// ---------------------------------------------------------------------------
export const leaderListItems = pgTable(
  "leader_list_items",
  {
    listId: integer("list_id")
      .notNull()
      .references(() => leaderLists.id, { onDelete: "cascade" }),
    address: text("address").notNull(),
    rank: integer("rank").notNull(),
    statsJson: jsonb("stats_json").$type<Record<string, unknown>>(),
  },
  (table) => [
    primaryKey({ columns: [table.listId, table.address] }),
    index("leader_list_items_address_idx").on(table.address, table.listId),
  ],
);

// ---------------------------------------------------------------------------
// leaders — 地址池主檔
// ---------------------------------------------------------------------------

export const leaders = pgTable(
  "leaders",
  {
    chain: text("chain").notNull().default(CHAIN_DEFAULT),
    address: text("address").notNull(),
    label: text("label"),
    tier: text("tier").$type<Tier>().notNull().default("B"),
    notes: text("notes"),
    active: boolean("active").notNull().default(true),
    /** Why it is watched: imported by an admin, or favorited by a user. */
    source: text("source").$type<LeaderSource>().notNull().default("import"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.chain, table.address] }),
    check("leaders_tier_check", oneOf(table.tier, tierEnum)),
    check("leaders_source_check", oneOf(table.source, leaderSourceEnum)),
  ],
);

// ---------------------------------------------------------------------------
// fills — 原始成交，永久保存
// ---------------------------------------------------------------------------
export const fills = pgTable(
  "fills",
  {
    chain: text("chain").notNull().default(CHAIN_DEFAULT),
    tid: bigint("tid", { mode: "bigint" }).notNull(),
    address: text("address").notNull(),
    coin: text("coin").notNull(),
    side: text("side").notNull(),
    dir: text("dir").notNull(),
    px: numeric("px").notNull(),
    sz: numeric("sz").notNull(),
    fee: numeric("fee").notNull(),
    closedPnl: numeric("closed_pnl"),
    hash: text("hash"),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    /** Full raw fill payload from Hyperliquid, kept for schema-change replay. */
    raw: jsonb("raw").$type<Record<string, unknown>>().notNull(),
  },
  // Both counterparties of a trade share one `tid` (verified live
  // 2026-09-29), so a (chain, tid) key would silently drop the second
  // watched wallet's fill when two leaders trade against each other.
  (table) => [
    primaryKey({ columns: [table.chain, table.address, table.tid] }),
    index("fills_address_ts_idx").on(table.address, table.ts.desc()),
    // "B" buy / "A" sell: the info client's validation admits nothing else.
    check("fills_side_check", oneOf(table.side, ["A", "B"])),
    check("fills_amounts_check", sql`${table.px} >= 0 and ${table.sz} >= 0`),
  ],
);

// ---------------------------------------------------------------------------
// actions — 聚合後的動作；規則與 Feed 只看這張表
// ---------------------------------------------------------------------------

export const actions = pgTable(
  "actions",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    chain: text("chain").notNull().default(CHAIN_DEFAULT),
    address: text("address").notNull(),
    coin: text("coin").notNull(),
    kind: text("kind").$type<ActionKind>().notNull(),
    side: text("side").notNull(),
    notionalUsd: numeric("notional_usd").notNull(),
    avgPx: numeric("avg_px").notNull(),
    leverage: numeric("leverage"),
    fillIds: bigint("fill_ids", { mode: "bigint" }).array().notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("actions_ts_idx").on(table.ts.desc()),
    index("actions_chain_address_ts_id_idx").on(table.chain, table.address, table.ts.desc(), table.id.desc()),
    index("actions_coin_ts_idx").on(table.coin, table.ts.desc()),
    check("actions_kind_check", oneOf(table.kind, actionKindEnum)),
    check("actions_side_check", oneOf(table.side, ["long", "short"])),
    check("actions_amounts_check", sql`${table.notionalUsd} >= 0 and ${table.avgPx} >= 0`),
  ],
);

// ---------------------------------------------------------------------------
// position_snapshots — 定時倉位快照
// ---------------------------------------------------------------------------
export const positionSnapshots = pgTable(
  "position_snapshots",
  {
    chain: text("chain").notNull().default(CHAIN_DEFAULT),
    address: text("address").notNull(),
    coin: text("coin").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    szi: numeric("szi").notNull(),
    entryPx: numeric("entry_px"),
    leverage: numeric("leverage"),
    marginMode: text("margin_mode"),
    unrealizedPnl: numeric("unrealized_pnl"),
    liqPx: numeric("liq_px"),
  },
  (table) => [
    primaryKey({
      columns: [table.chain, table.address, table.coin, table.ts],
    }),
    // The retention job deletes the oldest rows in batches (ts < cutoff).
    index("position_snapshots_ts_idx").on(table.ts),
  ],
);

// ---------------------------------------------------------------------------
// equity_snapshots — 權益曲線
// ---------------------------------------------------------------------------
export const equitySnapshots = pgTable(
  "equity_snapshots",
  {
    chain: text("chain").notNull().default(CHAIN_DEFAULT),
    address: text("address").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    accountValue: numeric("account_value").notNull(),
    totalMarginUsed: numeric("total_margin_used"),
    withdrawable: numeric("withdrawable"),
  },
  (table) => [
    primaryKey({ columns: [table.chain, table.address, table.ts] }),
    index("equity_snapshots_address_ts_idx").on(
      table.address,
      table.ts.desc(),
    ),
    // The retention job deletes the oldest rows in batches (ts < cutoff).
    index("equity_snapshots_ts_idx").on(table.ts),
  ],
);

// ---------------------------------------------------------------------------
// coin_meta — 精度與槓桿
// ---------------------------------------------------------------------------
export const coinMeta = pgTable(
  "coin_meta",
  {
    chain: text("chain").notNull().default(CHAIN_DEFAULT),
    coin: text("coin").notNull(),
    szDecimals: integer("sz_decimals").notNull(),
    maxLeverage: integer("max_leverage").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.chain, table.coin] }),
    check("coin_meta_bounds_check", sql`${table.szDecimals} >= 0 and ${table.maxLeverage} >= 1`),
  ],
);

// ---------------------------------------------------------------------------
// alert_rules — 規則
// ---------------------------------------------------------------------------


export const alertRules = pgTable(
  "alert_rules",
  {
    id: serial("id").primaryKey(),
    /** Owner. NULL rows are the defaults, evaluated for admins on imported
     * leaders. Per-user copies are no longer made (migration 0006 removed
     * them); users set alerts on their favorites instead. */
    userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
    scope: text("scope").$type<AlertRuleScope>().notNull(),
    kind: text("kind").$type<AlertRuleKind>().notNull(),
    paramsJson: jsonb("params_json").$type<Record<string, unknown>>().notNull(),
    cooldownS: integer("cooldown_s").notNull(),
    quietHours: jsonb("quiet_hours").$type<Record<string, unknown> | null>(),
    tiers: text("tiers").array().$type<Tier[]>().notNull(),
    enabled: boolean("enabled").notNull().default(true),
  },
  // One row per (user, kind), and one default row per kind.
  (table) => [
    uniqueIndex("alert_rules_user_kind_uq").on(table.userId, table.kind),
    uniqueIndex("alert_rules_default_kind_uq").on(table.kind).where(sql`${table.userId} is null`),
    check("alert_rules_scope_check", oneOf(table.scope, alertRuleScopeEnum)),
    check("alert_rules_kind_check", oneOf(table.kind, alertRuleKindEnum)),
    check("alert_rules_cooldown_check", sql`${table.cooldownS} >= 0`),
  ],
);

// ---------------------------------------------------------------------------
// alerts — 日誌與評分
// ---------------------------------------------------------------------------

export const alerts = pgTable(
  "alerts",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    /** The default rule that fired (admins, imported leaders); NULL for an
     * alert only a user's favorite alert triggered. */
    ruleId: integer("rule_id").references(() => alertRules.id, { onDelete: "restrict" }),
    /** Recipient; NULL for system messages and alerts from before users. */
    userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
    chain: text("chain").notNull().default(CHAIN_DEFAULT),
    address: text("address"),
    coin: text("coin"),
    actionId: bigint("action_id", { mode: "bigint" }).references(
      () => actions.id,
      { onDelete: "set null" },
    ),
    payloadJson: jsonb("payload_json").$type<Record<string, unknown>>().notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    sendStatus: text("send_status").$type<SendStatus>().notNull().default("pending"),
    pxAtSend: numeric("px_at_send"),
    px1h: numeric("px_1h"),
    px4h: numeric("px_4h"),
    px24h: numeric("px_24h"),
  },
  (table) => [
    index("alerts_sent_at_idx").on(table.sentAt.desc()),
    // Rows never stamped (a delivery that never finished): the retention job
    // finds them here instead of scanning the table.
    index("alerts_unsent_idx").on(table.id).where(sql`${table.sentAt} is null`),
    // Delivery: the outcome of one (action, recipient) is written to its rows
    // (NotifyRepository.recordDelivery), once per message sent.
    index("alerts_action_user_idx").on(table.actionId, table.userId),
    // Rule evaluation: each admin's last alert of a rule on this trader and
    // coin, for the cooldown (RulesRepository.lastSent), on every action of
    // an imported leader. sent_at is in the index, so the heap is not read.
    index("alerts_cooldown_idx").on(table.address, table.coin, table.userId, table.ruleId, table.sentAt),
    check("alerts_send_status_check", oneOf(table.sendStatus, sendStatusEnum)),
  ],
);

// ---------------------------------------------------------------------------
// users — one row per Privy account (Stage 2)
// ---------------------------------------------------------------------------

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  /** Privy DID, e.g. "did:privy:…". */
  privyUserId: text("privy_user_id").notNull().unique(),
  email: text("email"),
  walletAddress: text("wallet_address"),
  /** The user's Privy embedded wallet (lowercase): their Orbie main account
   * and Hyperliquid address. Read from Privy's verified user record, never
   * from the client; null until Privy reports one. `walletAddress` stays
   * the login identity (an external wallet wins there). */
  embeddedWalletAddress: text("embedded_wallet_address").unique(),
  displayName: text("display_name"),
  role: text("role").$type<UserRole>().notNull().default("user"),
  locale: text("locale").$type<Locale>().notNull().default("zh-TW"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }).notNull().defaultNow(),
  /** Set by an admin; a disabled user is treated as signed out. */
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
}, (table) => [check("users_role_check", oneOf(table.role, userRoleEnum))]);


// ---------------------------------------------------------------------------
// user_favorites — 收藏；收藏的地址也會進入監控清單（leaders.source='favorite'）
// ---------------------------------------------------------------------------
export const userFavorites = pgTable(
  "user_favorites",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    chain: text("chain").notNull().default(CHAIN_DEFAULT),
    address: text("address").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Telegram trade alerts for this trader (CopyDog-style): on/off, which
     * side, and an optional minimum notional. How many a user may switch on
     * is `app_settings.notifications.maxAlertTraders`. */
    alertEnabled: boolean("alert_enabled").notNull().default(false),
    alertSides: text("alert_sides").$type<AlertSides>().notNull().default("both"),
    alertMinUsd: numeric("alert_min_usd"),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.chain, table.address] }),
    // Who to alert when this address acts.
    index("user_favorites_alerting_idx")
      .on(table.chain, table.address)
      .where(sql`${table.alertEnabled}`),
    check("user_favorites_alert_sides_check", oneOf(table.alertSides, alertSidesEnum)),
    check("user_favorites_alert_min_check", sql`${table.alertMinUsd} >= 0`),
  ],
);

// ---------------------------------------------------------------------------
// notification_channels — 每位使用者自己的通知目的地
// ---------------------------------------------------------------------------

export const notificationChannels = pgTable(
  "notification_channels",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").$type<NotificationChannelKind>().notNull(),
    /** Telegram chat id. */
    target: text("target").notNull(),
    /** Telegram @username at link time (without "@"), for display. */
    username: text("username"),
    enabled: boolean("enabled").notNull().default(true),
    copyAlertsEnabled: boolean("copy_alerts_enabled").notNull().default(false),
    copyAlertsSince: timestamp("copy_alerts_since", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("notification_channels_user_kind_uq").on(table.userId, table.kind),
    check("notification_channels_kind_check", oneOf(table.kind, notificationChannelKindEnum)),
  ],
);

// ---------------------------------------------------------------------------
// trader_stats — 全站排行（官方 leaderboard 定期匯入），探索頁的資料來源
// ---------------------------------------------------------------------------

export const traderStats = pgTable(
  "trader_stats",
  {
    chain: text("chain").notNull().default(CHAIN_DEFAULT),
    address: text("address").notNull(),
    displayName: text("display_name"),
    accountValue: numeric("account_value").notNull(),
    pnlDay: numeric("pnl_day").notNull(),
    pnlWeek: numeric("pnl_week").notNull(),
    pnlMonth: numeric("pnl_month").notNull(),
    pnlAllTime: numeric("pnl_all_time").notNull(),
    roiDay: numeric("roi_day").notNull(),
    roiWeek: numeric("roi_week").notNull(),
    roiMonth: numeric("roi_month").notNull(),
    roiAllTime: numeric("roi_all_time").notNull(),
    volumeDay: numeric("volume_day").notNull(),
    volumeWeek: numeric("volume_week").notNull(),
    volumeMonth: numeric("volume_month").notNull(),
    volumeAllTime: numeric("volume_all_time").notNull(),
    /** Listed in Hyperliquid's vault list: its "account value" is TVL, not one trader's equity. */
    isVault: boolean("is_vault").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.chain, table.address] }),
    index("trader_stats_pnl_month_idx").on(table.pnlMonth.desc()),
    index("trader_stats_pnl_all_time_idx").on(table.pnlAllTime.desc()),
    index("trader_stats_account_value_idx").on(table.accountValue.desc()),
  ],
);

// ---------------------------------------------------------------------------
// app_settings — 管理員在後台調整的全站設定（每個區塊一列，value 由 zod 驗證）
// ---------------------------------------------------------------------------

export const appSettings = pgTable("app_settings", {
  key: text("key").$type<AppSettingsKey>().primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedByUserId: integer("updated_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
}, (table) => [check("app_settings_key_check", oneOf(table.key, appSettingsKeyEnum))]);

// ---------------------------------------------------------------------------
// revenue_snapshots — 平台地址在 Hyperliquid 的累計 builder fee 與推薦返佣
// （info `referral`），每小時一筆；收入 = 相鄰快照的差
// ---------------------------------------------------------------------------
export const revenueSnapshots = pgTable(
  "revenue_snapshots",
  {
    address: text("address").notNull(),
    takenAt: timestamp("taken_at", { withTimezone: true }).notNull(),
    /** Cumulative builder fees earned (USDC). */
    builderRewards: numeric("builder_rewards").notNull(),
    /** Cumulative referral rebates earned (USDC), builder fees excluded. */
    referralRewards: numeric("referral_rewards").notNull(),
    claimedRewards: numeric("claimed_rewards").notNull(),
    unclaimedRewards: numeric("unclaimed_rewards").notNull(),
    referredUsers: integer("referred_users").notNull().default(0),
    /** Cumulative volume of referred users (USD). */
    referredVolume: numeric("referred_volume").notNull().default("0"),
    raw: jsonb("raw").notNull(),
  },
  (table) => [primaryKey({ columns: [table.address, table.takenAt] })],
);

// ---------------------------------------------------------------------------
// telegram_link_tokens — one-time tokens for linking a Telegram chat to a
// user through the official bot (t.me/<bot>?start=<token>). Only a hash is
// stored; a token is valid for 10 minutes and used once.
// ---------------------------------------------------------------------------
export const telegramLinkTokens = pgTable(
  "telegram_link_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (table) => [index("telegram_link_tokens_user_idx").on(table.userId)],
);

// Durable work: action evaluation and per-recipient Telegram delivery.
export const actionOutbox = pgTable("action_outbox", {
  equityUsd: numeric("equity_usd"),
  actionId: bigint("action_id", { mode: "bigint" }).primaryKey().references(() => actions.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  lastError: text("last_error"),
}, (table) => [
  index("action_outbox_pending_idx").on(table.status, table.availableAt),
  check("action_outbox_status_check", oneOf(table.status, ["pending", "processing", "done", "failed"])),
  check("action_outbox_attempts_check", sql`${table.attempts} >= 0`),
]);

export const notificationOutbox = pgTable("notification_outbox", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  actionId: bigint("action_id", { mode: "bigint" }).references(() => actions.id, { onDelete: "cascade" }),
  copyEventId: bigint("copy_event_id", { mode: "bigint" }).references((): AnyPgColumn => copyEvents.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  payloadJson: jsonb("payload_json").$type<Record<string, unknown>>().notNull(),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  leaseToken: text("lease_token"),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("notification_outbox_action_user_uq").on(table.actionId, table.userId),
  uniqueIndex("notification_outbox_copy_event_user_uq").on(table.copyEventId, table.userId),
  check("notification_outbox_source_check", sql`(${table.actionId} is not null) <> (${table.copyEventId} is not null)`),
  index("notification_outbox_pending_idx").on(table.status, table.availableAt),
  check("notification_outbox_status_check", oneOf(table.status, ["pending", "processing", "sent", "dry_run", "failed"])),
  check("notification_outbox_attempts_check", sql`${table.attempts} >= 0`),
]);

export const notificationCooldowns = pgTable("notification_cooldowns", {
  key: text("key").primaryKey(),
  reservedAt: timestamp("reserved_at", { withTimezone: true }).notNull(),
});

/** Successful administrative mutations, written with their business transaction.
 * No foreign key: actor attribution must survive subsequent account deletion. */
export const adminAuditLogs = pgTable("admin_audit_logs", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  actorKind: text("actor_kind").notNull(),
  actorUserId: integer("actor_user_id"),
  event: text("event").notNull(),
  target: text("target").notNull(),
  beforeJson: jsonb("before_json"),
  afterJson: jsonb("after_json"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("admin_audit_logs_created_idx").on(table.createdAt),
  index("admin_audit_logs_actor_idx").on(table.actorUserId, table.createdAt),
  check("admin_audit_logs_actor_kind_check", oneOf(table.actorKind, ["user", "service", "system"])),
]);

/**
 * The data-retention job's single row (id = 1): its lease, so two workers
 * never clean at once, and what the last run did, for the admin system page.
 * `removed` and `cutoffs` are keyed by RETENTION_TABLES names.
 */
export const retentionState = pgTable("retention_state", {
  id: integer("id").primaryKey(),
  leaseToken: text("lease_token"),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  lastStartedAt: timestamp("last_started_at", { withTimezone: true }),
  lastFinishedAt: timestamp("last_finished_at", { withTimezone: true }),
  /** "ok": every table reached its cutoff; "partial": the run's batch or
   * time budget ended first (the next run continues); "failed": an error. */
  lastStatus: text("last_status").$type<"ok" | "partial" | "failed">(),
  removed: jsonb("removed").$type<Record<string, number>>(),
  cutoffs: jsonb("cutoffs").$type<Record<string, string>>(),
  lastError: text("last_error"),
  durationMs: integer("duration_ms"),
}, (table) => [
  check("retention_state_single_row", sql`${table.id} = 1`),
  check("retention_state_last_status_check", oneOf(table.lastStatus, ["ok", "partial", "failed"])),
]);

// ---------------------------------------------------------------------------
// trader_trades / trader_analytics — round trips reconstructed from fills for
// any address (the trader page's 交易 / 表現 tabs), and each address's
// summary and refresh cursors. Derived from fills, so safe to truncate.
// ---------------------------------------------------------------------------

export const traderTrades = pgTable(
  "trader_trades",
  {
    chain: text("chain").notNull().default(CHAIN_DEFAULT),
    address: text("address").notNull(),
    /** tid of the trade's first fill we hold: unique per address. */
    openTid: bigint("open_tid", { mode: "bigint" }).notNull(),
    coin: text("coin").notNull(),
    side: text("side").$type<"long" | "short">().notNull(),
    entryTime: timestamp("entry_time", { withTimezone: true }).notNull(),
    /** Null while open. */
    exitTime: timestamp("exit_time", { withTimezone: true }),
    /** Ledger order: exit time, or entry time while open. */
    sortTime: timestamp("sort_time", { withTimezone: true }).notNull(),
    /** Signed size now (0 once closed); the next refresh continues from it. */
    position: numeric("position").notNull(),
    /** Size already open before the first fill we hold (a partial trade),
     * and its price once solved from a closing fill. */
    preSize: numeric("pre_size").notNull().default("0"),
    prePx: numeric("pre_px"),
    entrySz: numeric("entry_sz").notNull(),
    entryNtl: numeric("entry_ntl").notNull(),
    exitSz: numeric("exit_sz").notNull(),
    exitNtl: numeric("exit_ntl").notNull(),
    realizedPnl: numeric("realized_pnl").notNull(),
    fees: numeric("fees").notNull(),
    /** Null when the hold started before funding was read. */
    funding: numeric("funding"),
    netPnl: numeric("net_pnl").notNull(),
    liquidated: boolean("liquidated").notNull().default(false),
    twap: boolean("twap").notNull().default(false),
    fills: integer("fills").notNull(),
    lastFillTime: timestamp("last_fill_time", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.chain, table.address, table.openTid] }),
    index("trader_trades_address_sort_idx").on(table.address, table.sortTime.desc(), table.openTid.desc()),
    check("trader_trades_side_check", oneOf(table.side, ["long", "short"])),
  ],
);

export const traderAnalytics = pgTable(
  "trader_analytics",
  {
    chain: text("chain").notNull().default(CHAIN_DEFAULT),
    address: text("address").notNull(),
    /** "tracked" (our fills table) or "hyperliquid" (its fill history). */
    source: text("source").$type<"tracked" | "hyperliquid">().notNull(),
    /** Earliest fill read. */
    coverageFrom: timestamp("coverage_from", { withTimezone: true }),
    /** Fixed cutoff of the persistent raw-history snapshot; null for legacy analytics. */
    historyThrough: timestamp("history_through", { withTimezone: true }),
    truncated: boolean("truncated").notNull().default(false),
    fillsRead: integer("fills_read").notNull().default(0),
    /** Time of the newest fill processed, and the tids at that millisecond
     * (the next read starts there, inclusive, and skips them). */
    fillCursor: timestamp("fill_cursor", { withTimezone: true }),
    cursorTids: jsonb("cursor_tids").$type<string[]>().notNull().default([]),
    /** Funding is complete for trades opened on or after `fundingFrom`, up
     * to `fundingCursor`; both null until funding was first read. */
    fundingFrom: timestamp("funding_from", { withTimezone: true }),
    fundingCursor: timestamp("funding_cursor", { withTimezone: true }),
    /** { all, 30d, 7d } summaries, as served. */
    summary: jsonb("summary").$type<Record<string, unknown>>().notNull(),
    classification: jsonb("classification").$type<Record<string, unknown>>().notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.chain, table.address] }),
    check("trader_analytics_source_check", oneOf(table.source, ["tracked", "hyperliquid"])),
  ],
);

// ---------------------------------------------------------------------------
// kol_traders — the KOL registry (Stage 3 §1.7): names, avatars and 𝕏
// handles for known traders, managed from the admin area. The explore page's
// KOL board and the home page's 精選 row list these addresses.
// ---------------------------------------------------------------------------

export const kolTraders = pgTable(
  "kol_traders",
  {
    chain: text("chain").notNull().default(CHAIN_DEFAULT),
    address: text("address").notNull(),
    displayName: text("display_name"),
    /** Explicit avatar; null → derived from the 𝕏 handle, else generated. */
    avatarUrl: text("avatar_url"),
    /** 𝕏 handle without "@". */
    xHandle: text("x_handle"),
    verified: boolean("verified").notNull().default(false),
    /** Ascending; ties by address. */
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.chain, table.address] })],
);

// ---------------------------------------------------------------------------
// discovery_traders — the discovery pool's cached figures (Stage 3 §1.7):
// the official leaderboard's top N traders active in 30 days plus every KOL,
// refreshed a slice at a time by a background job inside the Hyperliquid
// weight budget. Boards (explore, home) read only this table. Derived data,
// safe to truncate: the job rebuilds it.
// ---------------------------------------------------------------------------

/** Per-coin realized figures from the trade ledger (net of fees). */
export interface DiscoveryCoinStat {
  pnl: number;
  /** Σ size × entry price of the fills that opened or added (CopyDog's). */
  volume: number;
  trades: number;
  wins: number;
}

export const discoveryTraders = pgTable(
  "discovery_traders",
  {
    chain: text("chain").notNull().default(CHAIN_DEFAULT),
    address: text("address").notNull(),
    /** Rank in the candidate pool (1 = first); null for a KOL outside it. */
    poolRank: integer("pool_rank"),
    /** Selected by the latest pool build (top N or KOL). Rows that drop out
     * are deleted by the next build. */
    inPool: boolean("in_pool").notNull().default(true),
    accountValue: numeric("account_value"),
    /** Perp all-time / 30-day PnL and ROI (CopyDog's ROI: PnL ÷ peak net
     * deposits of the perp series). */
    pnlAll: numeric("pnl_all"),
    roiAll: numeric("roi_all"),
    pnl30d: numeric("pnl_30d"),
    roi30d: numeric("roi_30d"),
    /** Whole-account all-time risk figures (CopyDog's `copyScoreComponents`). */
    sharpe: numeric("sharpe"),
    maxDrawdown: numeric("max_drawdown"),
    returnSamples: integer("return_samples"),
    spanDays: numeric("span_days"),
    copyScore: integer("copy_score"),
    style: text("style"),
    /** Most-traded coins by volume, at most 5. */
    topCoins: text("top_coins").array().notNull().default(sql`'{}'::text[]`),
    lastTradeAt: timestamp("last_trade_at", { withTimezone: true }),
    coinStats: jsonb("coin_stats").$type<Record<string, DiscoveryCoinStat>>().notNull().default({}),
    /** Start of the fill history the coin figures cover. */
    tradesFrom: timestamp("trades_from", { withTimezone: true }),
    /** Whole-account PnL, all-time and 30-day, downsampled. */
    sparkline: jsonb("sparkline").$type<number[]>().notNull().default([]),
    sparkline30d: jsonb("sparkline_30d").$type<number[]>().notNull().default([]),
    portfolioAt: timestamp("portfolio_at", { withTimezone: true }),
    tradesAt: timestamp("trades_at", { withTimezone: true }),
    /** Last trade-ledger refresh attempt, successful or not: the ledger
     * loop's queue order and retry backoff. */
    attemptedAt: timestamp("attempted_at", { withTimezone: true }),
    /** Last performance (`portfolio`) refresh attempt, successful or not:
     * the performance loop's retry backoff. `portfolioAt` is the time of
     * the Hyperliquid read behind the stored figures. */
    performanceAttemptedAt: timestamp("performance_attempted_at", { withTimezone: true }),
    lastError: text("last_error"),
  },
  (table) => [
    primaryKey({ columns: [table.chain, table.address] }),
    index("discovery_traders_attempted_idx").on(table.attemptedAt),
    index("discovery_traders_score_idx").on(table.copyScore.desc()),
  ],
);


/** Postgres `bytea` as a Node Buffer. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

// ---------------------------------------------------------------------------
// Durable analysis history, separate from watcher fills so historical
// ingestion never creates trading alerts. Every field of every fill is kept,
// losslessly, in typed columns (see `apps/api/src/analytics/fill-codec.ts`
// for the mapping and its exactness rules); the previous layout held the
// whole fill as `raw jsonb` and cost about 3.5 times the space.
// ---------------------------------------------------------------------------

/** One row per (chain, address) that has history: the 4-byte id the fill
 * rows and both of their indexes carry instead of the 42-character address. */
export const historyAccounts = pgTable("history_accounts", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  chain: text("chain").notNull().default(CHAIN_DEFAULT),
  address: text("address").notNull(),
}, table => [
  uniqueIndex("history_accounts_chain_address_idx").on(table.chain, table.address),
]);

/** Dictionary of the repeated strings of a fill: coin, dir and feeToken. */
export const historyTerms = pgTable("history_terms", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  term: text("term").notNull(),
}, table => [
  uniqueIndex("history_terms_term_idx").on(table.term),
]);

/**
 * A fill of an address's history. The key is the former
 * `(chain, address, source, tid)`: `account_id` stands for (chain, address)
 * and `twap` for the source ("twap" true, "regular" false), so a fill read
 * from REST and from the archive is still one row.
 *
 * Column order is storage order: 8-byte columns, then 4-byte, then 1-byte,
 * then the variable-length ones, so no alignment padding is stored.
 */
export const historyFills = pgTable("history_fills", {
  tid: bigint("tid", { mode: "bigint" }).notNull(),
  time: timestamp("time", { withTimezone: true }).notNull(),
  oid: bigint("oid", { mode: "number" }),
  /** NULL: the fill says `"twapId": null`; -1: it has no such key. */
  twapId: bigint("twap_id", { mode: "number" }),
  accountId: integer("account_id").notNull().references(() => historyAccounts.id),
  coinId: integer("coin_id").references(() => historyTerms.id),
  dirId: integer("dir_id").references(() => historyTerms.id),
  feeTokenId: integer("fee_token_id").references(() => historyTerms.id),
  /** The stream the row was read from: TWAP slices (true) or fills (false). */
  twap: boolean("twap").notNull(),
  /** side "B" (true) or "A" (false). */
  sideBuy: boolean("side_buy"),
  crossed: boolean("crossed"),
  /** Where the row was first read: Hyperliquid's REST API or its public S3
   * node archive. Not part of the key, so both origins deduplicate by tid. */
  origin: text("origin").$type<"rest" | "s3">().notNull().default("rest"),
  /** 32 bytes; empty for the all-zero hash of a TWAP slice. */
  hash: bytea("hash"),
  px: numeric("px"),
  sz: numeric("sz"),
  startPosition: numeric("start_position"),
  closedPnl: numeric("closed_pnl"),
  fee: numeric("fee"),
  cloid: bytea("cloid"),
  builder: bytea("builder"),
  builderFee: numeric("builder_fee"),
  deployerFee: numeric("deployer_fee"),
  priorityGas: numeric("priority_gas"),
  liquidatedUser: bytea("liquidated_user"),
  liquidationMarkPx: numeric("liquidation_mark_px"),
  liquidationMethod: text("liquidation_method"),
  /** Keys without a column and values a column could not reproduce exactly. */
  extra: jsonb("extra").$type<Record<string, unknown>>(),
}, table => [
  primaryKey({ columns: [table.accountId, table.twap, table.tid] }),
  index("history_fills_account_time_idx").on(table.accountId, table.time),
  check("history_fills_origin_check", oneOf(table.origin, ["rest", "s3"])),
]);

export const analysisHistoryJobs = pgTable("analysis_history_jobs", {
  chain: text("chain").notNull().default(CHAIN_DEFAULT),
  address: text("address").notNull(),
  checkpoint: jsonb("checkpoint").$type<{
    until: number;
    sources: Record<"regular" | "twap", { cursor: number; through: number | null; status: "pending" | "complete" | "blocked" }>;
    reason: "timestamp_saturated" | null;
  }>().notNull(),
  version: integer("version").notNull().default(0),
  status: text("status").$type<"pending" | "caught_up" | "blocked">().notNull().default("pending"),
  /** Only advances when BOTH sources have completed the fixed interval. */
  publishedThrough: timestamp("published_through", { withTimezone: true }),
  attemptedAt: timestamp("attempted_at", { withTimezone: true }),
  lastError: text("last_error"),
  /** When a computation last asked for this job. A job for an address the
   * product does not otherwise know (not in the pool, a KOL, watched,
   * favorited or archived) is deleted, with its fills, once nobody has
   * asked for it for a while. */
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  primaryKey({ columns: [table.chain, table.address] }),
  index("analysis_history_jobs_attempted_idx").on(table.status, table.attemptedAt),
  check("analysis_history_jobs_status_check", oneOf(table.status, ["pending", "caught_up", "blocked"])),
]);

// ---------------------------------------------------------------------------
// kol_avatars — each KOL's picture, fetched once by the api (the admin's
// avatar URL, else the 𝕏 profile picture by handle) and served from
// GET /kols/:address/avatar, so boards never hotlink a third-party host.
// Refreshed weekly; a row without bytes records failed attempts.
// ---------------------------------------------------------------------------

export const kolAvatars = pgTable(
  "kol_avatars",
  {
    chain: text("chain").notNull().default(CHAIN_DEFAULT),
    address: text("address").notNull(),
    /** What was fetched: the stored avatar URL or "x:<handle>". A KOL whose
     * source changes is fetched again. */
    source: text("source").notNull(),
    /** Null until a fetch succeeds; kept when a later refresh fails. */
    bytes: bytea("bytes"),
    contentType: text("content_type"),
    /** Quoted strong ETag of `bytes` (sha-256 prefix). */
    etag: text("etag"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull().defaultNow(),
    /** Earliest next attempt (weekly after a success, later after a failure). */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    failures: integer("failures").notNull().default(0),
    lastError: text("last_error"),
  },
  (table) => [
    primaryKey({ columns: [table.chain, table.address] }),
    index("kol_avatars_next_idx").on(table.nextAttemptAt),
  ],
);

// ---------------------------------------------------------------------------
// cohort_members / cohort_snapshots — 洞察 (Stage 3 §3, CopyDog's cohorts):
// each PnL tier's members (the discovery pool's traders by all-time perp
// PnL, topped up from the leaderboard), their latest positions across every
// perp dex, and one aggregate row per tier every refresh interval (the
// 倉位傾向 history). Members are derived data: the job rebuilds them.
// ---------------------------------------------------------------------------

/** One open perp position of a cohort member. `notional` is signed (long
 * > 0, short < 0), at the mark. */
export interface CohortPosition {
  coin: string;
  notional: number;
  upnl: number;
}

export const cohortMembers = pgTable(
  "cohort_members",
  {
    chain: text("chain").notNull().default(CHAIN_DEFAULT),
    address: text("address").notNull(),
    /** A `PnlTier` (extremely_profitable … rekt). */
    tier: text("tier").notNull(),
    /** "pool" (discovery pool figures) or "leaderboard" (top-up). */
    source: text("source").notNull(),
    /** Order within the tier (account value, largest first). */
    rank: integer("rank").notNull(),
    pnlAll: numeric("pnl_all"),
    roiAll: numeric("roi_all"),
    /** Perp equity summed over every dex, from the latest snapshot. */
    perpEquity: numeric("perp_equity"),
    positions: jsonb("positions").$type<CohortPosition[]>().notNull().default([]),
    /** Dexes (besides the main one) the member held positions on or has
     * traded; queried every refresh. Every dex is swept now and then. */
    dexes: text("dexes").array().notNull().default(sql`'{}'::text[]`),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }),
    /** Last full sweep of every dex. */
    sweptAt: timestamp("swept_at", { withTimezone: true }),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }),
    lastError: text("last_error"),
  },
  (table) => [
    primaryKey({ columns: [table.chain, table.address] }),
    index("cohort_members_tier_idx").on(table.tier, table.rank),
    index("cohort_members_attempted_idx").on(table.attemptedAt),
  ],
);

export const cohortSnapshots = pgTable(
  "cohort_snapshots",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    chain: text("chain").notNull().default(CHAIN_DEFAULT),
    tier: text("tier").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    /** Immutable selected universe, not just its fresh contributors. Null on legacy rows. */
    membershipVersion: text("membership_version"),
    memberAddresses: text("member_addresses").array(),
    /** Members of the tier / members with a fresh snapshot. */
    memberCount: integer("member_count").notNull(),
    walletCount: integer("wallet_count").notNull(),
    notionalLong: numeric("notional_long").notNull(),
    notionalShort: numeric("notional_short").notNull(),
    /** Long ÷ (long + short) notional, 0–100; null without positions. */
    longPct: numeric("long_pct"),
    upnlProfit: numeric("upnl_profit").notNull(),
    upnlLoss: numeric("upnl_loss").notNull(),
    walletsInProfit: integer("wallets_in_profit").notNull(),
    walletsInLoss: integer("wallets_in_loss").notNull(),
  },
  (table) => [index("cohort_snapshots_tier_ts_idx").on(table.chain, table.tier, table.ts)],
);

// ===========================================================================
// Copy trading, Stage 4 step 3 (paper mode). Design: docs/Stage 4 — 跟單與管理
// （執行順序）.md §3 and docs/copy-execution-and-admin-review.md.
// Money is numeric (USDC); sizes are numeric in coin units. No table holds a
// key, signer or exchange credential.
// ===========================================================================

/** Immutable risk-policy versions (review A07). The newest row is in force;
 * every order records the version it was approved under. */
export const copyRiskPolicies = pgTable("copy_risk_policies", {
  version: serial("version").primaryKey(),
  limits: jsonb("limits").$type<Record<string, unknown>>().notNull(),
  reason: text("reason"),
  createdByUserId: integer("created_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Authoritative stop state for the platform (scope 'platform', id 0) and
 * each user (scope 'user', id = users.id). `revision` rises on every
 * command; the execution path reads these rows inside its own transaction
 * (FOR SHARE), never through a cache. */
export const copyControls = pgTable("copy_controls", {
  scope: text("scope").$type<Exclude<CopyControlScope, "strategy">>().notNull(),
  scopeId: integer("scope_id").notNull(),
  pauseNewRisk: boolean("pause_new_risk").notNull().default(false),
  reduceOnly: boolean("reduce_only").notNull().default(false),
  revision: bigint("revision", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedByUserId: integer("updated_by_user_id"),
}, (table) => [
  primaryKey({ columns: [table.scope, table.scopeId] }),
  check("copy_controls_scope_check", oneOf(table.scope, ["platform", "user"])),
  check("copy_controls_revision_check", sql`${table.revision} >= 0`),
]);

/** Every stop / resume command at any level, with who, why and what it did.
 * Admin commands are also in admin_audit_logs (same transaction). */
export const copyControlEvents = pgTable("copy_control_events", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  scope: text("scope").$type<CopyControlScope>().notNull(),
  scopeId: integer("scope_id").notNull(),
  command: text("command").$type<CopyControlCommand>().notNull(),
  revision: bigint("revision", { mode: "number" }).notNull(),
  actorUserId: integer("actor_user_id"),
  reason: text("reason"),
  result: jsonb("result").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("copy_control_events_created_idx").on(table.createdAt),
  check("copy_control_events_scope_check", oneOf(table.scope, copyControlScopeEnum)),
  check("copy_control_events_command_check", oneOf(table.command, copyControlCommandEnum)),
]);

/** Per-user virtual USDC (paper mode only; never the real wallet). `balance`
 * is what isn't allocated to a strategy. */
export const paperAccounts = pgTable("paper_accounts", {
  userId: integer("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  balance: numeric("balance").notNull(),
  startingBalance: numeric("starting_balance").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // What is not allocated to a copy: allocations are refused beyond it, and
  // a stopped copy returns its cash, which is never negative.
  check("paper_accounts_balance_check", sql`${table.balance} >= 0 and ${table.startingBalance} >= 0`),
]);

/** One copy of one leader by one user. Settings live in immutable
 * copy_strategy_versions; `version` is the one in force. Only fills at or
 * after `activatedAt` (the activation cursor) are copied. `cash` is the
 * strategy's isolated ledger balance: allocations + realized PnL − fees −
 * funding; equity adds unrealized PnL of copy_positions. */
export const copyStrategies = pgTable("copy_strategies", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  chain: text("chain").notNull().default(CHAIN_DEFAULT),
  leaderAddress: text("leader_address").notNull(),
  mode: text("mode").$type<"paper">().notNull().default("paper"),
  status: text("status").$type<CopyStrategyStatus>().notNull().default("active"),
  version: integer("version").notNull().default(1),
  allocated: numeric("allocated").notNull(),
  cash: numeric("cash").notNull(),
  withdrawn: numeric("withdrawn").notNull().default("0"),
  realizedPnl: numeric("realized_pnl").notNull().default("0"),
  fees: numeric("fees").notNull().default("0"),
  funding: numeric("funding").notNull().default("0"),
  /** Strategy-level stop state (the owner's pause / reduce-only). */
  pauseNewRisk: boolean("pause_new_risk").notNull().default(false),
  reduceOnly: boolean("reduce_only").notNull().default(false),
  controlRevision: bigint("control_revision", { mode: "number" }).notNull().default(0),
  activatedAt: timestamp("activated_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  stoppedAt: timestamp("stopped_at", { withTimezone: true }),
}, (table) => [
  index("copy_strategies_user_idx").on(table.userId, table.status),
  index("copy_strategies_leader_idx").on(table.chain, table.leaderAddress, table.status),
  // One live copy per user and leader (CopyDog: "Already copying").
  uniqueIndex("copy_strategies_live_uq").on(table.userId, table.chain, table.leaderAddress).where(sql`status <> 'stopped'`),
  check("copy_strategies_mode_check", oneOf(table.mode, ["paper"])),
  check("copy_strategies_status_check", oneOf(table.status, copyStrategyStatusEnum)),
  check("copy_strategies_amounts_check", sql`${table.allocated} > 0 and ${table.withdrawn} >= 0 and ${table.fees} >= 0 and ${table.version} >= 1 and ${table.controlRevision} >= 0`),
  // Cash may be below zero only while a position is open (see the note at
  // the top); what a stopped copy returned to the balance was not negative.
  check("copy_strategies_stopped_check", sql`(${table.status} = 'stopped') = (${table.stoppedAt} is not null) and (${table.status} <> 'stopped' or ${table.cash} >= 0)`),
]);

export interface CopyStrategySettingsJson {
  direction: CopyDirection;
  sizingMode: CopySizingMode;
  /** Fixed mode: USDC notional per copied open. */
  perTradeUsd: number | null;
  /** CopyDog `max_total_exposure`; null = allocation × 5 (CopyDog's display default). */
  maxTotalExposureUsd: number | null;
  /** CopyDog `max_leverage`; null = the platform cap. */
  maxLeverage: number | null;
  copyStartMode: CopyStartMode;
}

export const copyStrategyVersions = pgTable("copy_strategy_versions", {
  strategyId: integer("strategy_id").notNull().references(() => copyStrategies.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  settings: jsonb("settings").$type<CopyStrategySettingsJson>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdByUserId: integer("created_by_user_id"),
}, (table) => [primaryKey({ columns: [table.strategyId, table.version] })]);

/** Execution outbox: one row per verified leader fill (fills table) of an
 * address somebody copies, written in the fill's own insert transaction.
 * Consumed only by the copy signal consumer; the notification outbox
 * (action_outbox) is separate and never read here. */
export const copySignalOutbox = pgTable("copy_signal_outbox", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  chain: text("chain").notNull().default(CHAIN_DEFAULT),
  address: text("address").notNull(),
  tid: bigint("tid", { mode: "bigint" }).notNull(),
  fillTime: timestamp("fill_time", { withTimezone: true }).notNull(),
  status: text("status").$type<"pending" | "done" | "failed">().notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("copy_signal_outbox_fill_uq").on(table.chain, table.address, table.tid),
  index("copy_signal_outbox_pending_idx").on(table.status, table.id),
  check("copy_signal_outbox_status_check", oneOf(table.status, ["pending", "done", "failed"])),
  check("copy_signal_outbox_attempts_check", sql`${table.attempts} >= 0`),
]);

/** The consumer's own checkpoint: the highest outbox id below which every
 * row is done, advanced in the same transaction that marks rows done. */
export const copyConsumerCheckpoints = pgTable("copy_consumer_checkpoints", {
  consumer: text("consumer").primaryKey(),
  lastOutboxId: bigint("last_outbox_id", { mode: "bigint" }).notNull().default(sql`0`),
  processed: bigint("processed", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Dedupe of canonical signals: a (strategy, leader fill tid, leg) is acted on
 * at most once, whatever strategy version is current, however often the fill
 * is replayed. `dedupeKey` records strategy:tid:leg:vN; `orderId` is the order it went
 * into (null when skipped, with `outcome` saying why). */
export const copySignalLegs = pgTable("copy_signal_legs", {
  strategyId: integer("strategy_id").notNull().references(() => copyStrategies.id, { onDelete: "cascade" }),
  tid: bigint("tid", { mode: "bigint" }).notNull(),
  leg: text("leg").$type<CopyLeg>().notNull(),
  strategyVersion: integer("strategy_version").notNull(),
  dedupeKey: text("dedupe_key").notNull(),
  coin: text("coin").notNull(),
  fillTime: timestamp("fill_time", { withTimezone: true }).notNull(),
  orderId: bigint("order_id", { mode: "bigint" }),
  outcome: text("outcome").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.strategyId, table.tid, table.leg] }),
  index("copy_signal_legs_coin_time_idx").on(table.strategyId, table.coin, table.fillTime),
  check("copy_signal_legs_leg_check", oneOf(table.leg, ["open", "close"])),
]);

/** Paper (later testnet/live) orders and their state machine. Bound at
 * creation to the strategy version, risk-policy version and the control
 * revisions it was approved under. */
export const copyOrders = pgTable("copy_orders", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  /** Client order id: deterministic from the dedupe key, reused on retry. */
  cloid: text("cloid").notNull().unique(),
  strategyId: integer("strategy_id").notNull().references(() => copyStrategies.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull(),
  mode: text("mode").$type<"paper">().notNull().default("paper"),
  strategyVersion: integer("strategy_version").notNull(),
  riskPolicyVersion: integer("risk_policy_version").notNull(),
  /** Approval versions remain immutable; boundary versions are separate. */
  executionPolicyVersion: integer("execution_policy_version"),
  executionStrategyVersion: integer("execution_strategy_version"),
  executionControlRevisions: jsonb("execution_control_revisions").$type<{ platform: number; user: number; strategy: number }>(),
  executionFeeSnapshot: jsonb("execution_fee_snapshot").$type<{ takerFeeBps: number; builderFeeTenthsBps: number }>(),
  leaderAddress: text("leader_address").notNull(),
  coin: text("coin").notNull(),
  leg: text("leg").$type<CopyLeg>().notNull(),
  /** "B" buy / "A" sell, as Hyperliquid. */
  side: text("side").$type<"B" | "A">().notNull(),
  reduceOnly: boolean("reduce_only").notNull(),
  size: numeric("size").notNull(),
  /** Price the signal saw (leader fill px or mid at adoption). */
  signalPx: numeric("signal_px").notNull(),
  signalTime: timestamp("signal_time", { withTimezone: true }).notNull(),
  signalTids: bigint("signal_tids", { mode: "bigint" }).array().notNull(),
  status: text("status").$type<CopyOrderStatus>().notNull(),
  reason: text("reason"),
  /** platform / user / strategy control revisions seen at approval. */
  controlRevisions: jsonb("control_revisions").$type<{ platform: number; user: number; strategy: number }>().notNull(),
  filledSize: numeric("filled_size").notNull().default("0"),
  avgPx: numeric("avg_px"),
  fee: numeric("fee").notNull().default("0"),
  builderFee: numeric("builder_fee").notNull().default("0"),
  /** The leader trade an open belongs to: `oid:<order id>` or `twap:<id>`.
   * Fixed sizing spends its per-trade amount once per key (review 40). */
  tradeKey: text("trade_key"),
  /** Failed execution attempts (a fill that threw), and the last error:
   * an order that keeps failing is alerted on and listed in /admin/copy. */
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("copy_orders_strategy_idx").on(table.strategyId, table.createdAt.desc()),
  index("copy_orders_status_idx").on(table.status, table.id),
  index("copy_orders_trade_key_idx").on(table.strategyId, table.tradeKey).where(sql`${table.tradeKey} is not null`),
  check("copy_orders_mode_check", oneOf(table.mode, ["paper"])),
  check("copy_orders_leg_check", oneOf(table.leg, copyLegEnum)),
  check("copy_orders_side_check", oneOf(table.side, ["B", "A"])),
  check("copy_orders_status_check", oneOf(table.status, copyOrderStatusEnum)),
  // An order never fills more than it asked for, and only reductions are reduce-only.
  check("copy_orders_sizes_check", sql`${table.size} >= 0 and ${table.filledSize} >= 0 and ${table.filledSize} <= ${table.size}`),
  check("copy_orders_amounts_check", sql`${table.fee} >= 0 and ${table.builderFee} >= 0 and ${table.signalPx} >= 0 and ${table.avgPx} > 0 and ${table.attempts} >= 0`),
  check("copy_orders_reduce_only_check", sql`${table.reduceOnly} = (${table.leg} in ('close', 'stop_close', 'liquidation'))`),
]);

/** Margin held for an order between approval and fill, made in the same
 * transaction as the order; consumed on fill, released otherwise. */
export const copyReservations = pgTable("copy_reservations", {
  orderId: bigint("order_id", { mode: "bigint" }).primaryKey().references(() => copyOrders.id, { onDelete: "cascade" }),
  strategyId: integer("strategy_id").notNull().references(() => copyStrategies.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull(),
  coin: text("coin").notNull(),
  notional: numeric("notional").notNull(),
  margin: numeric("margin").notNull(),
  status: text("status").$type<"held" | "consumed" | "released">().notNull().default("held"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  settledAt: timestamp("settled_at", { withTimezone: true }),
}, (table) => [
  index("copy_reservations_held_idx").on(table.strategyId, table.status),
  check("copy_reservations_status_check", oneOf(table.status, ["held", "consumed", "released"])),
  check("copy_reservations_amounts_check", sql`${table.notional} >= 0 and ${table.margin} >= 0`),
]);

/** Simulated fills of paper orders. */
export const copyPaperFills = pgTable("copy_paper_fills", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  orderId: bigint("order_id", { mode: "bigint" }).notNull().references(() => copyOrders.id, { onDelete: "cascade" }),
  strategyId: integer("strategy_id").notNull().references(() => copyStrategies.id, { onDelete: "cascade" }),
  coin: text("coin").notNull(),
  side: text("side").$type<"B" | "A">().notNull(),
  size: numeric("size").notNull(),
  px: numeric("px").notNull(),
  /** The mid or mark the fill started from, before slippage. */
  basePx: numeric("base_px").notNull(),
  priceSource: text("price_source").notNull(),
  slippageBps: numeric("slippage_bps").notNull(),
  fee: numeric("fee").notNull(),
  builderFee: numeric("builder_fee").notNull(),
  realizedPnl: numeric("realized_pnl").notNull(),
  ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("copy_paper_fills_strategy_idx").on(table.strategyId, table.ts.desc()),
  check("copy_paper_fills_side_check", oneOf(table.side, ["B", "A"])),
  check("copy_paper_fills_amounts_check", sql`${table.size} > 0 and ${table.px} > 0 and ${table.basePx} > 0 and ${table.fee} >= 0 and ${table.builderFee} >= 0`),
]);

/** A strategy's own position per coin, isolated from its other strategies
 * and from the leader's numbers. `size` is signed (long > 0). */
export const copyPositions = pgTable("copy_positions", {
  strategyId: integer("strategy_id").notNull().references(() => copyStrategies.id, { onDelete: "cascade" }),
  coin: text("coin").notNull(),
  size: numeric("size").notNull(),
  entryPx: numeric("entry_px").notNull(),
  realizedPnl: numeric("realized_pnl").notNull().default("0"),
  funding: numeric("funding").notNull().default("0"),
  /** Size the leader's reductions called for that was below the coin's lot
   * size and has not been traded yet (review 42): it is added to the next
   * reduction instead of being rounded away. Always less than one lot's
   * worth of drift per reduction; cleared when the position closes. */
  reduceCarry: numeric("reduce_carry").notNull().default("0"),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
  /** Funding is accrued per whole hour up to here (idempotent per hour). */
  fundingThrough: timestamp("funding_through", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.strategyId, table.coin] }),
  // An open position has an entry price; what is owed to later reductions
  // is never more than the position.
  check("copy_positions_entry_check", sql`${table.entryPx} >= 0 and (${table.size} = 0 or ${table.entryPx} > 0)`),
  check("copy_positions_carry_check", sql`${table.reduceCarry} >= 0 and ${table.reduceCarry} <= abs(${table.size})`),
]);

/** Append-only money movements of a strategy (and paper account transfers). */
export const copyLedger = pgTable("copy_ledger", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  strategyId: integer("strategy_id").notNull().references(() => copyStrategies.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull(),
  /** `liquidation` is the loss beyond the strategy's equity that a
   * liquidation writes off (cash is brought back to 0, never below). */
  kind: text("kind").$type<"allocate" | "realized_pnl" | "fee" | "builder_fee" | "funding" | "release" | "withdraw" | "liquidation">().notNull(),
  amount: numeric("amount").notNull(),
  coin: text("coin"),
  orderId: bigint("order_id", { mode: "bigint" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("copy_ledger_strategy_idx").on(table.strategyId, table.id),
  check("copy_ledger_kind_check", oneOf(table.kind, ["allocate", "realized_pnl", "fee", "builder_fee", "funding", "release", "withdraw", "liquidation"])),
  // The sign each kind always has: money in on an allocation or a
  // write-off, out on a fee or a release. PnL and funding go either way;
  // no row is zero.
  check("copy_ledger_sign_check", sql`${table.amount} <> 0 and case ${table.kind} when 'allocate' then ${table.amount} > 0 when 'liquidation' then ${table.amount} > 0 when 'fee' then ${table.amount} < 0 when 'builder_fee' then ${table.amount} < 0 when 'release' then ${table.amount} < 0 when 'withdraw' then ${table.amount} < 0 else true end`),
]);

/** Atomic paper mutations; a key is bound to one normalized operation. */
export const copyOperations = pgTable("copy_operations", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  mode: text("mode").notNull(), network: text("network").notNull(), key: text("key").notNull(),
  operation: text("operation").notNull(), fingerprint: text("fingerprint").notNull(),
  result: jsonb("result").$type<{ strategyId: number }>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("copy_operations_key_uq").on(t.userId, t.mode, t.network, t.key)]);

export const copyEvents = pgTable("copy_events", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  strategyId: integer("strategy_id").references(() => copyStrategies.id, { onDelete: "cascade" }),
  type: text("type").notNull(), payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  notificationQueuedAt: timestamp("notification_queued_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("copy_events_owner_cursor_idx").on(t.userId, t.id)]);

/** Unknown marks remain null; installation never fabricates older history. */
export const copyEquitySnapshots = pgTable("copy_equity_snapshots", {
  strategyId: integer("strategy_id").notNull().references(() => copyStrategies.id, { onDelete: "cascade" }),
  time: timestamp("time", { withTimezone: true }).notNull(),
  equity: numeric("equity"), totalPnl: numeric("total_pnl"), netDeposits: numeric("net_deposits").notNull(), exposureUsd: numeric("exposure_usd"),
}, (t) => [primaryKey({ columns: [t.strategyId, t.time] })]);

/** Durable user-owned master wallet preparation, separate from delegated agent
 * identities below. Preparing a wallet never switches a paper strategy to live. */
export const copyExecutionAccounts = pgTable("copy_execution_accounts", {
  id: text("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  strategyId: integer("strategy_id").notNull().references(() => copyStrategies.id, { onDelete: "restrict" }),
  network: text("network").$type<"testnet" | "mainnet">().notNull(),
  privyUserId: text("privy_user_id").notNull(), externalId: text("external_id").notNull().unique(),
  revision: integer("revision").notNull().default(1),
  state: text("state").$type<"requested" | "unknown" | "ready" | "blocked">().notNull().default("requested"),
  privyWalletId: text("privy_wallet_id").unique(), ownerQuorumId: text("owner_quorum_id"), address: text("address").unique(),
  issue: text("issue").$type<"verification_pending" | "provider_unavailable" | "wallet_conflict">(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("copy_execution_accounts_strategy_uq").on(t.network, t.strategyId),
  index("copy_execution_accounts_owner_idx").on(t.userId, t.createdAt),
  check("copy_execution_accounts_network_check", oneOf(t.network, ["testnet", "mainnet"])),
  check("copy_execution_accounts_state_check", oneOf(t.state, ["requested", "unknown", "ready", "blocked"])),
  check("copy_execution_accounts_revision_check", sql`${t.revision} >= 1`),
  check("copy_execution_accounts_issue_check", oneOf(t.issue, ["verification_pending", "provider_unavailable", "wallet_conflict"])),
  check("copy_execution_accounts_ready_check", sql`${t.state} <> 'ready' or (${t.privyWalletId} is not null and ${t.ownerQuorumId} is not null and ${t.address} is not null and ${t.address} ~ '^0x[0-9a-f]{40}$' and ${t.issue} is null)`),
]);

/** Live identity records deliberately restrict deletion; no raw keys or tokens. */
export const copyExecutionWallets = pgTable("copy_execution_wallets", {
  id: text("id").primaryKey(), userId: integer("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  strategyId: integer("strategy_id").notNull(), network: text("network").$type<"testnet" | "mainnet">().notNull(),
  accountAddress: text("account_address").notNull(), privyWalletId: text("privy_wallet_id").notNull(), privyOwnerId: text("privy_owner_id").notNull(),
  signerAddress: text("signer_address").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("copy_execution_wallets_account_uq").on(t.network, t.accountAddress),
  uniqueIndex("copy_execution_wallets_strategy_uq").on(t.network, t.strategyId),
  check("copy_execution_wallets_network_check", oneOf(t.network, ["testnet", "mainnet"]))]);

export const copyWalletAuthorizations = pgTable("copy_wallet_authorizations", {
  id: text("id").primaryKey(), walletId: text("wallet_id").notNull().references(() => copyExecutionWallets.id, { onDelete: "restrict" }),
  version: integer("version").notNull(), scopes: jsonb("scopes").$type<Array<"copy:trade" | "copy:reduce">>().notNull(),
  validFrom: timestamp("valid_from", { withTimezone: true }).notNull(), expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }), exchangeApprovedAt: timestamp("exchange_approved_at", { withTimezone: true }),
}, (t) => [index("copy_wallet_authorizations_wallet_idx").on(t.walletId),
  check("copy_wallet_authorizations_version_check", sql`${t.version} >= 1 and ${t.expiresAt} > ${t.validFrom}`)]);

/** Immutable consent revocation evidence. No provider credentials or signatures. */
export const copyWalletAuthorizationEvents = pgTable("copy_wallet_authorization_events", {
  id: text("id").primaryKey(),
  authorizationId: text("authorization_id").notNull().references(() => copyWalletAuthorizations.id, { onDelete: "restrict" }),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  version: integer("version").notNull(), action: text("action").$type<"revoked">().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("copy_wallet_authorization_events_version_uq").on(t.authorizationId, t.version),
  check("copy_wallet_authorization_events_action_check", sql`${t.action} = 'revoked' and ${t.version} >= 2`)]);

export const copySignerNonces = pgTable("copy_signer_nonces", {
  network: text("network").notNull(), signerAddress: text("signer_address").notNull(), nonce: bigint("nonce", { mode: "number" }).notNull(),
}, (t) => [primaryKey({ columns: [t.network, t.signerAddress] }),
  check("copy_signer_nonces_network_check", oneOf(t.network, ["testnet", "mainnet"])), check("copy_signer_nonces_value_check", sql`${t.nonce} >= 0 and ${t.nonce} <= 9007199254740991`)]);

/** External intents survive process failure. JSON contains no signatures/private keys. */
export const copyLiveExecutions = pgTable("copy_live_executions", {
  key: text("key").primaryKey(), network: text("network").notNull(), accountAddress: text("account_address").notNull(),
  signerAddress: text("signer_address").notNull(), cloid: text("cloid").notNull(), nonce: bigint("nonce", { mode: "number" }).notNull(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "restrict" }), strategyId: integer("strategy_id").notNull(),
  state: text("state").notNull(), record: jsonb("record").$type<Record<string, unknown>>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}, (t) => [uniqueIndex("copy_live_executions_nonce_uq").on(t.network, t.signerAddress, t.nonce),
  index("copy_live_executions_owner_idx").on(t.userId, t.updatedAt), index("copy_live_executions_recovery_idx").on(t.state, t.updatedAt),
  check("copy_live_executions_network_check", oneOf(t.network, ["testnet", "mainnet"])),
  check("copy_live_executions_state_check", oneOf(t.state, ["prepared", "submitting", "unknown", "resting", "filled", "partial", "cancelled", "rejected"]))]);

/** Durable initial watched-address backfill. Admission shares the leader transaction. */
export const backfillJobs = pgTable("backfill_jobs", {
  id: serial("id").primaryKey(),
  chain: text("chain").notNull().default(CHAIN_DEFAULT),
  address: text("address").notNull(),
  source: text("source").$type<"import" | "favorite">().notNull(),
  status: text("status").$type<"pending" | "running" | "completed" | "failed">().notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  runAttempts: integer("run_attempts").notNull().default(0),
  version: integer("version").notNull().default(0),
  leaseToken: text("lease_token"),
  leaseExpiresAt: timestamp("lease_expires_at", {withTimezone: true}),
  availableAt: timestamp("available_at", {withTimezone: true}).notNull().defaultNow(),
  createdAt: timestamp("created_at", {withTimezone: true}).notNull().defaultNow(),
  startedAt: timestamp("started_at", {withTimezone: true}),
  completedAt: timestamp("completed_at", {withTimezone: true}),
  fillsFetched: integer("fills_fetched"),
  lastErrorCode: text("last_error_code").$type<"backfill_failed" | "lease_expired">(),
}, table => [uniqueIndex("backfill_jobs_address_uq").on(table.chain, table.address),
  index("backfill_jobs_pending_idx").on(table.status, table.availableAt),
  index("backfill_jobs_lease_idx").on(table.status, table.leaseExpiresAt),
  check("backfill_jobs_source_check", oneOf(table.source, ["import", "favorite"])),
  check("backfill_jobs_status_check", oneOf(table.status, ["pending", "running", "completed", "failed"])),
  check("backfill_jobs_error_code_check", oneOf(table.lastErrorCode, ["backfill_failed", "lease_expired"])),
  check("backfill_jobs_counts_check", sql`${table.attempts} >= 0 and ${table.runAttempts} >= 0 and ${table.version} >= 0`)]);


/** Private organization only; deleting a group never deletes a favorite.
 * `color` / `sort_order` drive the favorites page's group chips (CopyDog's
 * watchlist groups): chip colour "#rrggbb" (null → the palette colour for
 * the id) and ascending order, ties by id. */
export const favoriteGroups = pgTable("favorite_groups", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  color: text("color"),
  sortOrder: integer("sort_order").notNull().default(0),
}, table => [uniqueIndex("favorite_groups_owner_id_uq").on(table.userId, table.id), uniqueIndex("favorite_groups_owner_name_uq").on(table.userId, sql`lower(${table.name})`)]);
export const favoriteGroupMembers = pgTable("favorite_group_members", {
  userId: integer("user_id").notNull(), groupId: integer("group_id").notNull(),
  chain: text("chain").notNull().default(CHAIN_DEFAULT), address: text("address").notNull(),
}, table => [
  primaryKey({ columns: [table.groupId, table.chain, table.address] }),
  foreignKey({ columns: [table.userId, table.groupId], foreignColumns: [favoriteGroups.userId, favoriteGroups.id] }).onDelete("cascade"),
  foreignKey({ columns: [table.userId, table.chain, table.address], foreignColumns: [userFavorites.userId, userFavorites.chain, userFavorites.address] }).onDelete("cascade"),
  index("favorite_group_members_owner_idx").on(table.userId),
]);


// ---------------------------------------------------------------------------
// Hyperliquid public node archive (S3 `hl-mainnet-node-data`) ingest.
// Fills land in `history_fills` (origin = "s3"); these two tables
// hold only the cursors, so they are small and must be backed up.
// ---------------------------------------------------------------------------

/** One row per chain: the forward (live) and backward (backfill) cursors
 * over hourly archive objects, and the transfer accounting behind the
 * daily spend cap. Every object commits its fills, the coverage it adds and
 * this row in one transaction; `version` rejects a stale worker. */
export const archiveIngestState = pgTable("archive_ingest_state", {
  chain: text("chain").primaryKey().default(CHAIN_DEFAULT),
  /** Start of the next hour to ingest going forward; null before the first run. */
  liveNextHour: timestamp("live_next_hour", { withTimezone: true }),
  /** Start of the next hour to ingest going backward; null when no pass runs. */
  backfillCursorHour: timestamp("backfill_cursor_hour", { withTimezone: true }),
  /** When the latest backfill pass began; the next one waits
   * `S3_ARCHIVE_PASS_INTERVAL_HOURS` from it. Null: none yet, or the last
   * one stopped at a missing object and may be retried at once. */
  backfillPassStartedAt: timestamp("backfill_pass_started_at", { withTimezone: true }),
  objects: bigint("objects", { mode: "number" }).notNull().default(0),
  bytes: bigint("bytes", { mode: "number" }).notNull().default(0),
  fillsSeen: bigint("fills_seen", { mode: "number" }).notNull().default(0),
  fillsKept: bigint("fills_kept", { mode: "number" }).notNull().default(0),
  /** UTC day the spend counter belongs to, and bytes downloaded that day. */
  spendDay: text("spend_day"),
  spendDayBytes: bigint("spend_day_bytes", { mode: "number" }).notNull().default(0),
  lastObjectKey: text("last_object_key"),
  lastObjectAt: timestamp("last_object_at", { withTimezone: true }),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  /** A fixed code (never provider text): e.g. "missing_object", "parse_error". */
  lastError: text("last_error"),
  version: integer("version").notNull().default(0),
});

/** Per address: the contiguous span of hourly archive objects already
 * filtered for it, `[covered_from, covered_through)` on hour boundaries.
 * An address enters as "queued" (no span); the live cursor starts its span
 * and a backfill pass extends `covered_from` backward to the archive's
 * first day. "excluded": too many fills per hour to keep (a market maker);
 * it stays on the REST path and is never reported as archive-covered. */
export const archiveCoverage = pgTable("archive_coverage", {
  chain: text("chain").notNull().default(CHAIN_DEFAULT),
  address: text("address").notNull(),
  status: text("status").$type<"active" | "excluded">().notNull().default("active"),
  coveredFrom: timestamp("covered_from", { withTimezone: true }),
  coveredThrough: timestamp("covered_through", { withTimezone: true }),
  queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  primaryKey({ columns: [table.chain, table.address] }),
  index("archive_coverage_from_idx").on(table.coveredFrom),
  index("archive_coverage_through_idx").on(table.coveredThrough),
  check("archive_coverage_status_check", oneOf(table.status, ["active", "excluded"])),
]);

// ---------------------------------------------------------------------------
// fill_coverage — what the watcher's `fills` table is proven to hold.
// ---------------------------------------------------------------------------

/** A position-chain break that a targeted re-read of both fill endpoints
 * did not close: upstream itself has no fill between the two. */
export interface FillCoverageBreak { coin: string; tid: number; time: number; after: number; expected: string; actual: string }

/**
 * Per watched address: the one contiguous span `[verified_from,
 * verified_through]` in which every regular and TWAP fill Hyperliquid's
 * REST API returned is stored in `fills`. The span only grows by a read
 * that completed (short final page on both endpoints): forward from
 * `verified_through` (sweeps, restarts) and backward from `verified_from`
 * (backfill). A failed or interrupted read leaves it unchanged, so the
 * next one starts from the same place and nothing is skipped. Fills stored
 * outside the span (live confirms ahead of it, rows from before this table
 * existed) are kept but never counted as covered.
 */
export const fillCoverage = pgTable("fill_coverage", {
  chain: text("chain").notNull().default(CHAIN_DEFAULT),
  address: text("address").notNull(),
  verifiedFrom: timestamp("verified_from", { withTimezone: true }),
  verifiedThrough: timestamp("verified_through", { withTimezone: true }),
  /** Position continuity has been checked for fills up to here. */
  checkedThrough: timestamp("checked_through", { withTimezone: true }),
  /** Backward backfill: "pending" until it reaches `backfill_floor`
   * ("complete"), the start of what the REST API still retains
   * ("retention": older fills exist upstream only in the node archive),
   * the fill cap ("capped") or a millisecond holding more fills than the
   * API pages through ("blocked"). Anything but "complete" means the
   * figures are partial since `verified_from`. */
  backfillStatus: text("backfill_status").$type<"pending" | "complete" | "retention" | "capped" | "blocked">().notNull().default("pending"),
  backfillFloor: timestamp("backfill_floor", { withTimezone: true }).notNull(),
  /** Length of the next backward window, sized from the density just read. */
  backfillSpanMs: bigint("backfill_span_ms", { mode: "number" }).notNull().default(21_600_000),
  breaks: jsonb("breaks").$type<FillCoverageBreak[]>().notNull().default([]),
  /** When history inside or before the span last changed (backfilled fills,
   * a repaired hole): analytics computed before this are recomputed. */
  revisedAt: timestamp("revised_at", { withTimezone: true }),
  /** A fixed code, never provider text. */
  lastError: text("last_error"),
  failedAt: timestamp("failed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  primaryKey({ columns: [table.chain, table.address] }),
  index("fill_coverage_backfill_idx").on(table.backfillStatus, table.updatedAt),
  check("fill_coverage_backfill_status_check", oneOf(table.backfillStatus, ["pending", "complete", "retention", "capped", "blocked"])),
]);
