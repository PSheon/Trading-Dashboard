import type { actions } from "@trading-dashboard/shared/database";

/** Emitted in-process after each `actions` row is persisted; RulesModule
 * listens instead of polling the table. */
export const ACTION_CREATED_EVENT = "action.created";

/** The persisted row: Rules/Notify need its `id` for the `alerts.action_id` FK. */
export type ActionCreatedEvent = typeof actions.$inferSelect;

/**
 * Fast-path actions the slow path corrected (`FillSyncService.verify`), after
 * commit. Not an alert trigger: open pages fix their rows (stream `update`).
 * - `updated`: rows corrected in place (same id; kind/side changed).
 * - `inserted`: rows split off a corrected action (new ids).
 */
export const ACTION_CORRECTED_EVENT = "action.corrected";
export interface ActionCorrectedEvent {
  updated: Array<typeof actions.$inferSelect>;
  inserted: Array<typeof actions.$inferSelect>;
}
