import type { actions } from "@trading-dashboard/shared/database";

/**
 * Rules trigger mechanism (§1 of the M2 task): the Watcher emits this event,
 * in-process, right after each `actions` row is persisted — RulesModule
 * listens for it (`@OnEvent(ACTION_CREATED_EVENT)`) instead of polling the
 * `actions` table. Deliberate latency choice (keeps the ~20s poll-cycle
 * latency from growing) per the task's explicit instruction.
 */
export const ACTION_CREATED_EVENT = "action.created";

/** The full persisted row (including its DB-generated `id`), not just the
 * pre-insert draft — Rules/Notify need the real `action_id` for the
 * `alerts.action_id` FK. */
export type ActionCreatedEvent = typeof actions.$inferSelect;

/**
 * The slow path re-derived fast-path actions from their real fills and
 * changed them (`FillSyncService.verify`); emitted after the transaction
 * committed. Not an alert trigger (the alert already went out): it lets open
 * pages fix the rows they show (GET /actions/stream `update` events).
 * - `updated`: rows corrected in place (same id; kind/side changed).
 * - `inserted`: rows split off a corrected action (new ids).
 */
export const ACTION_CORRECTED_EVENT = "action.corrected";
export interface ActionCorrectedEvent {
  updated: Array<typeof actions.$inferSelect>;
  inserted: Array<typeof actions.$inferSelect>;
}
