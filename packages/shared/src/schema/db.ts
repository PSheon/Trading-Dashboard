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
import { sql } from "drizzle-orm";

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
});


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

// Durable work: action evaluation and per-recipient Telegram delivery.
export const actionOutbox = pgTable("action_outbox", {
  equityUsd: numeric("equity_usd"),
  actionId: bigint("action_id", { mode: "bigint" }).primaryKey().references(() => actions.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  lastError: text("last_error"),
}, (table) => [index("action_outbox_pending_idx").on(table.status, table.availableAt)]);

export const notificationOutbox = pgTable("notification_outbox", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  actionId: bigint("action_id", { mode: "bigint" }).notNull().references(() => actions.id, { onDelete: "cascade" }),
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
  index("notification_outbox_pending_idx").on(table.status, table.availableAt),
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
}, (table) => [index("admin_audit_logs_created_idx").on(table.createdAt), index("admin_audit_logs_actor_idx").on(table.actorUserId, table.createdAt)]);

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
  (table) => [primaryKey({ columns: [table.chain, table.address] })],
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
    /** Last refresh attempt, successful or not: the job's queue order. */
    attemptedAt: timestamp("attempted_at", { withTimezone: true }),
    lastError: text("last_error"),
  },
  (table) => [
    primaryKey({ columns: [table.chain, table.address] }),
    index("discovery_traders_attempted_idx").on(table.attemptedAt),
    index("discovery_traders_score_idx").on(table.copyScore.desc()),
  ],
);


/** Durable analysis history, separate from watcher fills so historical
 * ingestion never creates trading alerts. Both streams retain raw payloads. */
export const analysisHistoryFills = pgTable("analysis_history_fills", {
  chain: text("chain").notNull().default(CHAIN_DEFAULT),
  address: text("address").notNull(),
  source: text("source").$type<"regular" | "twap">().notNull(),
  tid: bigint("tid", { mode: "bigint" }).notNull(),
  time: timestamp("time", { withTimezone: true }).notNull(),
  raw: jsonb("raw").$type<Record<string, unknown>>().notNull(),
  /** Where the row was first read: Hyperliquid's REST API or its public S3
   * node archive. Not part of the key, so both origins deduplicate by tid. */
  origin: text("origin").$type<"rest" | "s3">().notNull().default("rest"),
}, table => [
  primaryKey({ columns: [table.chain, table.address, table.source, table.tid] }),
  index("analysis_history_fills_address_time_idx").on(table.chain, table.address, table.time),
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
}, table => [
  primaryKey({ columns: [table.chain, table.address] }),
  index("analysis_history_jobs_attempted_idx").on(table.status, table.attemptedAt),
]);

// ---------------------------------------------------------------------------
// kol_avatars — each KOL's picture, fetched once by the api (the admin's
// avatar URL, else the 𝕏 profile picture by handle) and served from
// GET /kols/:address/avatar, so boards never hotlink a third-party host.
// Refreshed weekly; a row without bytes records failed attempts.
// ---------------------------------------------------------------------------

/** Postgres `bytea` as a Node Buffer. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

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
}, (table) => [primaryKey({ columns: [table.scope, table.scopeId] })]);

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
}, (table) => [index("copy_control_events_created_idx").on(table.createdAt)]);

/** Per-user virtual USDC (paper mode only; never the real wallet). `balance`
 * is what isn't allocated to a strategy. */
export const paperAccounts = pgTable("paper_accounts", {
  userId: integer("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  balance: numeric("balance").notNull(),
  startingBalance: numeric("starting_balance").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("copy_orders_strategy_idx").on(table.strategyId, table.createdAt.desc()),
  index("copy_orders_status_idx").on(table.status, table.id),
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
}, (table) => [index("copy_reservations_held_idx").on(table.strategyId, table.status)]);

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
}, (table) => [index("copy_paper_fills_strategy_idx").on(table.strategyId, table.ts.desc())]);

/** A strategy's own position per coin, isolated from its other strategies
 * and from the leader's numbers. `size` is signed (long > 0). */
export const copyPositions = pgTable("copy_positions", {
  strategyId: integer("strategy_id").notNull().references(() => copyStrategies.id, { onDelete: "cascade" }),
  coin: text("coin").notNull(),
  size: numeric("size").notNull(),
  entryPx: numeric("entry_px").notNull(),
  realizedPnl: numeric("realized_pnl").notNull().default("0"),
  funding: numeric("funding").notNull().default("0"),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
  /** Funding is accrued per whole hour up to here (idempotent per hour). */
  fundingThrough: timestamp("funding_through", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.strategyId, table.coin] })]);

/** Append-only money movements of a strategy (and paper account transfers). */
export const copyLedger = pgTable("copy_ledger", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  strategyId: integer("strategy_id").notNull().references(() => copyStrategies.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull(),
  kind: text("kind").$type<"allocate" | "realized_pnl" | "fee" | "builder_fee" | "funding" | "release">().notNull(),
  amount: numeric("amount").notNull(),
  coin: text("coin"),
  orderId: bigint("order_id", { mode: "bigint" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("copy_ledger_strategy_idx").on(table.strategyId, table.id)]);

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
  index("backfill_jobs_lease_idx").on(table.status, table.leaseExpiresAt)]);


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
// Fills land in `analysis_history_fills` (origin = "s3"); these two tables
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
]);
