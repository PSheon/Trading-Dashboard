import { sql, type SQL } from "drizzle-orm";

/**
 * What account deletion does with every place a users.id is stored
 * (docs/account-deletion.md). test/account-closure-guard.spec.ts reads the
 * live schema and fails when a column holding a user id is missing here, or
 * when the database's own delete rule disagrees with the handling below, so
 * a new table can't make deletion fail on a foreign key again.
 *
 * - `cascade`: personal data, removed with the user row (ON DELETE CASCADE).
 * - `set_null`: kept without attribution (ON DELETE SET NULL).
 * - `tombstone`: a record that must be kept (money, orders, consent, audit).
 *   It is re-pointed to the deletion's anonymous tombstone user, so it stays
 *   valid without identifying the person, and is purged with that tombstone
 *   after RETENTION_ACCOUNT_DELETION_DAYS ({@link purgeStatements}).
 */
export type UserReferenceHandling = "cascade" | "set_null" | "tombstone";

export const USER_REFERENCES = {
  // Personal data: deleted with the account.
  "alert_rules.user_id": "cascade",
  "alerts.user_id": "cascade",
  "notification_channels.user_id": "cascade",
  "telegram_link_tokens.user_id": "cascade",
  "notification_outbox.user_id": "cascade",
  "user_favorites.user_id": "cascade",
  "favorite_groups.user_id": "cascade",
  "favorite_group_members.user_id": "cascade",
  "paper_accounts.user_id": "cascade",
  "copy_events.user_id": "cascade",
  "copy_operations.user_id": "cascade",
  // A setting an admin edited keeps its value.
  "app_settings.updated_by_user_id": "set_null",
  // Copies: a paper copy is deleted (it never held money); a testnet copy,
  // or any copy a kept record points at, is kept ({@link KEPT_STRATEGY}).
  "copy_strategies.user_id": "tombstone",
  "copy_strategy_versions.created_by_user_id": "tombstone",
  "copy_orders.user_id": "tombstone",
  "copy_ledger.user_id": "tombstone",
  "copy_reservations.user_id": "tombstone",
  // Testnet execution: accounts, wallets, consent, orders, fills, transfers.
  "copy_execution_accounts.user_id": "tombstone",
  "copy_execution_wallets.user_id": "tombstone",
  "copy_wallet_authorization_events.user_id": "tombstone",
  "copy_funding_operations.user_id": "tombstone",
  "copy_agent_setups.user_id": "tombstone",
  "copy_account_mode_operations.user_id": "tombstone",
  "copy_live_strategy_configs.user_id": "tombstone",
  "copy_live_mandates.user_id": "tombstone",
  "copy_live_stop_operations.user_id": "tombstone",
  "copy_live_stop_consents.user_id": "tombstone",
  "copy_live_executions.user_id": "tombstone",
  "copy_live_risk_reservations.user_id": "tombstone",
  "copy_live_execution_evidence.user_id": "tombstone",
  "copy_live_dispatches.user_id": "tombstone",
  "copy_live_activations.user_id": "tombstone",
  "copy_live_builder_approvals.user_id": "tombstone",
  "copy_live_leverage_updates.user_id": "tombstone",
  "copy_live_manual_closes.user_id": "tombstone",
  "copy_live_setups.user_id": "tombstone",
  "copy_follower_observations.user_id": "tombstone",
  // Main-wallet withdrawals.
  "wallet_withdrawals.user_id": "tombstone",
  // Invites: kept as "a deleted user" on the other person's side, because
  // reward entitlement is computed from the attribution (referral ledger).
  "referral_attributions.referred_user_id": "tombstone",
  "referral_attributions.referrer_user_id": "tombstone",
  "referral_claims.user_id": "tombstone",
  "referral_ledger.user_id": "tombstone",
  // Only codes an invite was made with are kept (reserved, never current);
  // the rest are deleted ({@link KEPT_REFERRAL_CODE}).
  "referral_codes.user_id": "tombstone",
  // Audit trails keep who did what, as the tombstone.
  "admin_audit_logs.actor_user_id": "tombstone",
  "copy_control_events.actor_user_id": "tombstone",
  "copy_controls.updated_by_user_id": "tombstone",
  "copy_risk_policies.created_by_user_id": "tombstone",
  // A user's own copy switch (scope 'user', scope_id = users.id) and its history.
  "copy_controls.scope_id": "tombstone",
  "copy_control_events.scope_id": "tombstone",
} as const satisfies Record<string, UserReferenceHandling>;
export type UserReference = keyof typeof USER_REFERENCES;

/**
 * Rows deleted explicitly just before the user row, because a RESTRICT key
 * would otherwise stop the cascade: alert records of the user's own alert
 * rules (they are the user's alerts, but another account's alert row could
 * point at the rule too). Keyed by the restricting `table.column`.
 */
export function deletedBeforeUser(userId: number): Record<string, SQL> {
  return {
    "alerts.rule_id": sql`delete from alerts where rule_id in (select id from alert_rules where user_id = ${userId})`,
  };
}

/** Tables whose rows point at a copy strategy and must not lose it
 * (RESTRICT): a strategy any of them references is kept. The guard checks
 * this list against the schema's foreign keys to copy_strategies. */
export const STRATEGY_RECORD_TABLES = [
  "copy_execution_accounts", "copy_funding_operations", "copy_agent_setups", "copy_account_mode_operations", "copy_live_risk_reservations",
  "copy_live_strategy_configs", "copy_live_execution_evidence", "copy_follower_observations", "copy_live_position_baselines",
  "copy_live_activations", "copy_live_dispatches", "copy_live_manual_closes", "copy_live_setups",
] as const;

/** A strategy that is kept (re-pointed to the tombstone): every testnet
 * copy, and a paper copy a kept record points at. `s` is copy_strategies. */
export const KEPT_STRATEGY = sql.join([sql.raw(`(s.mode <> 'paper'`),
  ...STRATEGY_RECORD_TABLES.map((table) => sql.raw(` or exists (select 1 from ${table} r where r.strategy_id = s.id)`)), sql.raw(")")], sql``);

/** A referral code an invite was made with (`c` is referral_codes). */
export const KEPT_REFERRAL_CODE = sql`exists (select 1 from referral_attributions a where a.code_id = c.id)`;

function split(reference: string): [string, string] {
  const [table, column] = reference.split(".");
  return [table!, column!];
}

/** The re-pointing statements, run before the user row is deleted. */
export function repointStatements(userId: number, tombstoneId: number): Array<{ reference: UserReference; statement: SQL }> {
  const out: Array<{ reference: UserReference; statement: SQL }> = [];
  for (const [reference, handling] of Object.entries(USER_REFERENCES) as Array<[UserReference, UserReferenceHandling]>) {
    if (handling !== "tombstone") continue;
    const [table, column] = split(reference);
    const target = sql.identifier(table), col = sql.identifier(column);
    if (reference === "copy_strategies.user_id") {
      out.push({ reference, statement: sql`update copy_strategies s set user_id = ${tombstoneId} where s.user_id = ${userId} and ${KEPT_STRATEGY}` });
    } else if (reference === "copy_controls.scope_id" || reference === "copy_control_events.scope_id") {
      out.push({ reference, statement: sql`update ${target} set scope_id = ${tombstoneId} where scope = 'user' and scope_id = ${userId}` });
    } else if (reference === "referral_codes.user_id") {
      out.push({ reference, statement: sql`update referral_codes c set user_id = ${tombstoneId}, is_current = false where c.user_id = ${userId} and ${KEPT_REFERRAL_CODE}` });
    } else {
      out.push({ reference, statement: sql`update ${target} set ${col} = ${tombstoneId} where ${col} = ${userId}` });
    }
  }
  return out;
}

/**
 * Removes one tombstone and every kept record under it, children before
 * parents (the foreign keys are RESTRICT on purpose). The guard checks that
 * every table reachable from a tombstoned table through a non-cascading
 * foreign key is listed, and that each comes before the tables it points at.
 * Shared rows (leader fills and streams, policies) are never touched.
 */
export function purgeStatements(tombstoneId: number): Array<{ table: string; statement: SQL }> {
  const t = tombstoneId;
  const accounts = sql`(select id from copy_execution_accounts where user_id = ${t})`;
  const mandates = sql`(select id from copy_live_mandates where user_id = ${t})`;
  const executions = sql`(select key from copy_live_executions where user_id = ${t})`;
  const stops = sql`(select id from copy_live_stop_operations where user_id = ${t})`;
  const wallets = sql`(select id from copy_execution_wallets where user_id = ${t})`;
  const receipts = sql`(select key from copy_follower_receipts where account_id in ${accounts} or execution_key in ${executions})`;
  const grants = sql`(select id from copy_wallet_authorizations where wallet_id in ${wallets})`;
  const plan: Array<[string, SQL]> = [
    ["copy_follower_receipt_conflicts", sql`receipt_key in ${receipts}`],
    ["copy_follower_ledger", sql`receipt_key in ${receipts}`],
    ["copy_follower_receipts", sql`account_id in ${accounts} or execution_key in ${executions}`],
    ["copy_follower_observation_jobs", sql`account_id in ${accounts}`],
    ["copy_follower_observations", sql`user_id = ${t} or account_id in ${accounts}`],
    ["copy_follower_account_state", sql`account_id in ${accounts}`],
    ["copy_follower_scans", sql`account_id in ${accounts}`],
    ["copy_live_stop_cancellations", sql`stop_id in ${stops} or execution_key in ${executions}`],
    ["copy_live_stop_consents", sql`user_id = ${t} or stop_id in ${stops}`],
    ["copy_live_intent_provenance", sql`key in ${executions} or mandate_id in ${mandates}`],
    ["copy_live_position_baselines", sql`mandate_id in ${mandates} or account_id in ${accounts} or first_execution_key in ${executions}`],
    ["copy_live_dispatches", sql`user_id = ${t} or mandate_id in ${mandates} or account_id in ${accounts}`],
    ["copy_live_signal_legs", sql`mandate_id in ${mandates} or execution_key in ${executions}`],
    ["copy_live_reduction_carry", sql`mandate_id in ${mandates}`],
    ["copy_live_activations", sql`user_id = ${t} or mandate_id in ${mandates}`],
    ["copy_live_risk_reservations", sql`user_id = ${t} or key in ${executions} or account_id in ${accounts}`],
    ["copy_live_execution_evidence", sql`user_id = ${t} or key in ${executions} or account_id in ${accounts}`],
    ["copy_live_manual_closes", sql`user_id = ${t} or account_id in ${accounts}`],
    ["copy_funding_operations", sql`user_id = ${t} or account_id in ${accounts}`],
    ["copy_live_stop_operations", sql`user_id = ${t}`],
    ["copy_live_mandates", sql`user_id = ${t}`],
    ["copy_live_executions", sql`user_id = ${t}`],
    ["copy_live_builder_approvals", sql`user_id = ${t} or account_id in ${accounts}`],
    ["copy_live_leverage_updates", sql`user_id = ${t} or account_id in ${accounts}`],
    ["copy_account_mode_operations", sql`user_id = ${t} or account_id in ${accounts}`],
    ["copy_agent_setups", sql`user_id = ${t} or account_id in ${accounts}`],
    ["copy_live_setups", sql`user_id = ${t}`],
    ["copy_wallet_authorization_events", sql`user_id = ${t} or authorization_id in ${grants}`],
    ["copy_wallet_authorizations", sql`wallet_id in ${wallets}`],
    ["copy_execution_wallets", sql`user_id = ${t}`],
    ["copy_live_strategy_configs", sql`user_id = ${t}`],
    ["copy_execution_accounts", sql`user_id = ${t}`],
    ["wallet_withdrawals", sql`user_id = ${t}`],
    ["referral_ledger", sql`user_id = ${t}`],
    ["referral_claims", sql`user_id = ${t}`],
    ["referral_attributions", sql`referred_user_id = ${t} or referrer_user_id = ${t}`],
    ["referral_codes", sql`user_id = ${t}`],
    // Cascades to the copy's versions, orders, fills, positions and ledger.
    ["copy_strategies", sql`user_id = ${t}`],
    ["copy_control_events", sql`scope = 'user' and scope_id = ${t}`],
    ["copy_controls", sql`scope = 'user' and scope_id = ${t}`],
    ["users", sql`id = ${t} and deleted_at is not null`],
  ];
  return plan.map(([table, where]) => ({ table, statement: sql`delete from ${sql.identifier(table)} where ${where}` }));
}
