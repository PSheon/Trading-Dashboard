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
import { sql } from "drizzle-orm";

/** All core tables are chain-scoped; v1 only ever writes 'hyperliquid'. */
export const CHAIN_DEFAULT = "hyperliquid" as const;

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
  (table) => [primaryKey({ columns: [table.listId, table.address] })],
);

// ---------------------------------------------------------------------------
// leaders — 地址池主檔
// ---------------------------------------------------------------------------
export const tierEnum = ["A", "B", "C"] as const;
export const leaderSourceEnum = ["import", "favorite"] as const;
export type LeaderSource = (typeof leaderSourceEnum)[number];
export type Tier = (typeof tierEnum)[number];

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
  (table) => [primaryKey({ columns: [table.chain, table.address] })],
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
  ],
);

// ---------------------------------------------------------------------------
// actions — 聚合後的動作；規則與 Feed 只看這張表
// ---------------------------------------------------------------------------
export const actionKindEnum = [
  "open",
  "add",
  "reduce",
  "close",
  "flip",
  "liquidation",
] as const;
export type ActionKind = (typeof actionKindEnum)[number];

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
    index("actions_coin_ts_idx").on(table.coin, table.ts.desc()),
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
  (table) => [primaryKey({ columns: [table.chain, table.coin] })],
);

// ---------------------------------------------------------------------------
// alert_rules — 規則
// ---------------------------------------------------------------------------
export const alertRuleScopeEnum = ["address", "group"] as const;
export type AlertRuleScope = (typeof alertRuleScopeEnum)[number];

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
export type AlertRuleKind = (typeof alertRuleKindEnum)[number];

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
  ],
);

// ---------------------------------------------------------------------------
// alerts — 日誌與評分
// ---------------------------------------------------------------------------
export const sendStatusEnum = ["pending", "sent", "failed", "dry_run"] as const;
export type SendStatus = (typeof sendStatusEnum)[number];

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
  (table) => [index("alerts_sent_at_idx").on(table.sentAt.desc())],
);

// ---------------------------------------------------------------------------
// users — one row per Privy account (Stage 2)
// ---------------------------------------------------------------------------
export const userRoleEnum = ["user", "admin"] as const;
export type UserRole = (typeof userRoleEnum)[number];
export const localeEnum = ["zh-TW", "en"] as const;
export type Locale = (typeof localeEnum)[number];

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  /** Privy DID, e.g. "did:privy:…". */
  privyUserId: text("privy_user_id").notNull().unique(),
  email: text("email"),
  walletAddress: text("wallet_address"),
  displayName: text("display_name"),
  role: text("role").$type<UserRole>().notNull().default("user"),
  locale: text("locale").$type<Locale>().notNull().default("zh-TW"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }).notNull().defaultNow(),
  /** Set by an admin; a disabled user is treated as signed out. */
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
});

export const alertSidesEnum = ["buy", "sell", "both"] as const;
export type AlertSides = (typeof alertSidesEnum)[number];

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
  ],
);

// ---------------------------------------------------------------------------
// notification_channels — 每位使用者自己的通知目的地
// ---------------------------------------------------------------------------
export const notificationChannelKindEnum = ["telegram"] as const;
export type NotificationChannelKind = (typeof notificationChannelKindEnum)[number];

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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("notification_channels_user_kind_uq").on(table.userId, table.kind)],
);

// ---------------------------------------------------------------------------
// trader_stats — 全站排行（官方 leaderboard 定期匯入），探索頁的資料來源
// ---------------------------------------------------------------------------
export const traderWindowEnum = ["day", "week", "month", "allTime"] as const;
export type TraderWindow = (typeof traderWindowEnum)[number];

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
export const appSettingsKeyEnum = ["general", "discovery", "notifications", "revenue"] as const;
export type AppSettingsKey = (typeof appSettingsKeyEnum)[number];

export const appSettings = pgTable("app_settings", {
  key: text("key").$type<AppSettingsKey>().primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedByUserId: integer("updated_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
});

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
