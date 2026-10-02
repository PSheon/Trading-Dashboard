ALTER TABLE "action_outbox" ADD CONSTRAINT "action_outbox_status_check" CHECK ("action_outbox"."status" in ('pending', 'processing', 'done', 'failed'));--> statement-breakpoint
ALTER TABLE "action_outbox" ADD CONSTRAINT "action_outbox_attempts_check" CHECK ("action_outbox"."attempts" >= 0);--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_kind_check" CHECK ("actions"."kind" in ('open', 'add', 'reduce', 'close', 'flip', 'liquidation'));--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_side_check" CHECK ("actions"."side" in ('long', 'short'));--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_amounts_check" CHECK ("actions"."notional_usd" >= 0 and "actions"."avg_px" >= 0);--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_actor_kind_check" CHECK ("admin_audit_logs"."actor_kind" in ('user', 'service', 'system'));--> statement-breakpoint
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_scope_check" CHECK ("alert_rules"."scope" in ('address', 'group'));--> statement-breakpoint
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_kind_check" CHECK ("alert_rules"."kind" in ('R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9'));--> statement-breakpoint
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_cooldown_check" CHECK ("alert_rules"."cooldown_s" >= 0);--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_send_status_check" CHECK ("alerts"."send_status" in ('pending', 'sent', 'failed', 'dry_run'));--> statement-breakpoint
ALTER TABLE "analysis_history_jobs" ADD CONSTRAINT "analysis_history_jobs_status_check" CHECK ("analysis_history_jobs"."status" in ('pending', 'caught_up', 'blocked'));--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_key_check" CHECK ("app_settings"."key" in ('general', 'discovery', 'notifications', 'revenue'));--> statement-breakpoint
ALTER TABLE "archive_coverage" ADD CONSTRAINT "archive_coverage_status_check" CHECK ("archive_coverage"."status" in ('active', 'excluded'));--> statement-breakpoint
ALTER TABLE "backfill_jobs" ADD CONSTRAINT "backfill_jobs_source_check" CHECK ("backfill_jobs"."source" in ('import', 'favorite'));--> statement-breakpoint
ALTER TABLE "backfill_jobs" ADD CONSTRAINT "backfill_jobs_status_check" CHECK ("backfill_jobs"."status" in ('pending', 'running', 'completed', 'failed'));--> statement-breakpoint
ALTER TABLE "backfill_jobs" ADD CONSTRAINT "backfill_jobs_error_code_check" CHECK ("backfill_jobs"."last_error_code" in ('backfill_failed', 'lease_expired'));--> statement-breakpoint
ALTER TABLE "backfill_jobs" ADD CONSTRAINT "backfill_jobs_counts_check" CHECK ("backfill_jobs"."attempts" >= 0 and "backfill_jobs"."run_attempts" >= 0 and "backfill_jobs"."version" >= 0);--> statement-breakpoint
ALTER TABLE "coin_meta" ADD CONSTRAINT "coin_meta_bounds_check" CHECK ("coin_meta"."sz_decimals" >= 0 and "coin_meta"."max_leverage" >= 1);--> statement-breakpoint
ALTER TABLE "copy_control_events" ADD CONSTRAINT "copy_control_events_scope_check" CHECK ("copy_control_events"."scope" in ('platform', 'user', 'strategy'));--> statement-breakpoint
ALTER TABLE "copy_control_events" ADD CONSTRAINT "copy_control_events_command_check" CHECK ("copy_control_events"."command" in ('pause_new_risk', 'cancel_pending', 'reduce_only', 'close_positions', 'resume'));--> statement-breakpoint
ALTER TABLE "copy_controls" ADD CONSTRAINT "copy_controls_scope_check" CHECK ("copy_controls"."scope" in ('platform', 'user'));--> statement-breakpoint
ALTER TABLE "copy_controls" ADD CONSTRAINT "copy_controls_revision_check" CHECK ("copy_controls"."revision" >= 0);--> statement-breakpoint
ALTER TABLE "copy_ledger" ADD CONSTRAINT "copy_ledger_kind_check" CHECK ("copy_ledger"."kind" in ('allocate', 'realized_pnl', 'fee', 'builder_fee', 'funding', 'release', 'liquidation'));--> statement-breakpoint
ALTER TABLE "copy_ledger" ADD CONSTRAINT "copy_ledger_sign_check" CHECK ("copy_ledger"."amount" <> 0 and case "copy_ledger"."kind" when 'allocate' then "copy_ledger"."amount" > 0 when 'liquidation' then "copy_ledger"."amount" > 0 when 'fee' then "copy_ledger"."amount" < 0 when 'builder_fee' then "copy_ledger"."amount" < 0 when 'release' then "copy_ledger"."amount" < 0 else true end);--> statement-breakpoint
ALTER TABLE "copy_orders" ADD CONSTRAINT "copy_orders_mode_check" CHECK ("copy_orders"."mode" in ('paper'));--> statement-breakpoint
ALTER TABLE "copy_orders" ADD CONSTRAINT "copy_orders_leg_check" CHECK ("copy_orders"."leg" in ('open', 'close', 'adopt', 'stop_close', 'liquidation'));--> statement-breakpoint
ALTER TABLE "copy_orders" ADD CONSTRAINT "copy_orders_side_check" CHECK ("copy_orders"."side" in ('B', 'A'));--> statement-breakpoint
ALTER TABLE "copy_orders" ADD CONSTRAINT "copy_orders_status_check" CHECK ("copy_orders"."status" in ('intent', 'risk_approved', 'submitting', 'submitted', 'unknown', 'partial', 'filled', 'rejected', 'cancelled'));--> statement-breakpoint
ALTER TABLE "copy_orders" ADD CONSTRAINT "copy_orders_sizes_check" CHECK ("copy_orders"."size" >= 0 and "copy_orders"."filled_size" >= 0 and "copy_orders"."filled_size" <= "copy_orders"."size");--> statement-breakpoint
ALTER TABLE "copy_orders" ADD CONSTRAINT "copy_orders_amounts_check" CHECK ("copy_orders"."fee" >= 0 and "copy_orders"."builder_fee" >= 0 and "copy_orders"."signal_px" >= 0 and "copy_orders"."avg_px" > 0 and "copy_orders"."attempts" >= 0);--> statement-breakpoint
ALTER TABLE "copy_orders" ADD CONSTRAINT "copy_orders_reduce_only_check" CHECK ("copy_orders"."reduce_only" = ("copy_orders"."leg" in ('close', 'stop_close', 'liquidation')));--> statement-breakpoint
ALTER TABLE "copy_paper_fills" ADD CONSTRAINT "copy_paper_fills_side_check" CHECK ("copy_paper_fills"."side" in ('B', 'A'));--> statement-breakpoint
ALTER TABLE "copy_paper_fills" ADD CONSTRAINT "copy_paper_fills_amounts_check" CHECK ("copy_paper_fills"."size" > 0 and "copy_paper_fills"."px" > 0 and "copy_paper_fills"."base_px" > 0 and "copy_paper_fills"."fee" >= 0 and "copy_paper_fills"."builder_fee" >= 0);--> statement-breakpoint
ALTER TABLE "copy_positions" ADD CONSTRAINT "copy_positions_entry_check" CHECK ("copy_positions"."entry_px" >= 0 and ("copy_positions"."size" = 0 or "copy_positions"."entry_px" > 0));--> statement-breakpoint
ALTER TABLE "copy_positions" ADD CONSTRAINT "copy_positions_carry_check" CHECK ("copy_positions"."reduce_carry" >= 0 and "copy_positions"."reduce_carry" <= abs("copy_positions"."size"));--> statement-breakpoint
ALTER TABLE "copy_reservations" ADD CONSTRAINT "copy_reservations_status_check" CHECK ("copy_reservations"."status" in ('held', 'consumed', 'released'));--> statement-breakpoint
ALTER TABLE "copy_reservations" ADD CONSTRAINT "copy_reservations_amounts_check" CHECK ("copy_reservations"."notional" >= 0 and "copy_reservations"."margin" >= 0);--> statement-breakpoint
ALTER TABLE "copy_signal_legs" ADD CONSTRAINT "copy_signal_legs_leg_check" CHECK ("copy_signal_legs"."leg" in ('open', 'close'));--> statement-breakpoint
ALTER TABLE "copy_signal_outbox" ADD CONSTRAINT "copy_signal_outbox_status_check" CHECK ("copy_signal_outbox"."status" in ('pending', 'done', 'failed'));--> statement-breakpoint
ALTER TABLE "copy_signal_outbox" ADD CONSTRAINT "copy_signal_outbox_attempts_check" CHECK ("copy_signal_outbox"."attempts" >= 0);--> statement-breakpoint
ALTER TABLE "copy_strategies" ADD CONSTRAINT "copy_strategies_mode_check" CHECK ("copy_strategies"."mode" in ('paper'));--> statement-breakpoint
ALTER TABLE "copy_strategies" ADD CONSTRAINT "copy_strategies_status_check" CHECK ("copy_strategies"."status" in ('active', 'paused', 'stopping', 'stopped'));--> statement-breakpoint
ALTER TABLE "copy_strategies" ADD CONSTRAINT "copy_strategies_amounts_check" CHECK ("copy_strategies"."allocated" > 0 and "copy_strategies"."fees" >= 0 and "copy_strategies"."version" >= 1 and "copy_strategies"."control_revision" >= 0);--> statement-breakpoint
ALTER TABLE "copy_strategies" ADD CONSTRAINT "copy_strategies_stopped_check" CHECK (("copy_strategies"."status" = 'stopped') = ("copy_strategies"."stopped_at" is not null) and ("copy_strategies"."status" <> 'stopped' or "copy_strategies"."cash" >= 0));--> statement-breakpoint
ALTER TABLE "fill_coverage" ADD CONSTRAINT "fill_coverage_backfill_status_check" CHECK ("fill_coverage"."backfill_status" in ('pending', 'complete', 'retention', 'capped', 'blocked'));--> statement-breakpoint
ALTER TABLE "fills" ADD CONSTRAINT "fills_side_check" CHECK ("fills"."side" in ('A', 'B'));--> statement-breakpoint
ALTER TABLE "fills" ADD CONSTRAINT "fills_amounts_check" CHECK ("fills"."px" >= 0 and "fills"."sz" >= 0);--> statement-breakpoint
ALTER TABLE "history_fills" ADD CONSTRAINT "history_fills_origin_check" CHECK ("history_fills"."origin" in ('rest', 's3'));--> statement-breakpoint
ALTER TABLE "leaders" ADD CONSTRAINT "leaders_tier_check" CHECK ("leaders"."tier" in ('A', 'B', 'C'));--> statement-breakpoint
ALTER TABLE "leaders" ADD CONSTRAINT "leaders_source_check" CHECK ("leaders"."source" in ('import', 'favorite', 'copy'));--> statement-breakpoint
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_kind_check" CHECK ("notification_channels"."kind" in ('telegram'));--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_status_check" CHECK ("notification_outbox"."status" in ('pending', 'processing', 'sent', 'dry_run', 'failed'));--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_attempts_check" CHECK ("notification_outbox"."attempts" >= 0);--> statement-breakpoint
ALTER TABLE "paper_accounts" ADD CONSTRAINT "paper_accounts_balance_check" CHECK ("paper_accounts"."balance" >= 0 and "paper_accounts"."starting_balance" >= 0);--> statement-breakpoint
ALTER TABLE "retention_state" ADD CONSTRAINT "retention_state_last_status_check" CHECK ("retention_state"."last_status" in ('ok', 'partial', 'failed'));--> statement-breakpoint
ALTER TABLE "trader_analytics" ADD CONSTRAINT "trader_analytics_source_check" CHECK ("trader_analytics"."source" in ('tracked', 'hyperliquid'));--> statement-breakpoint
ALTER TABLE "trader_trades" ADD CONSTRAINT "trader_trades_side_check" CHECK ("trader_trades"."side" in ('long', 'short'));--> statement-breakpoint
ALTER TABLE "user_favorites" ADD CONSTRAINT "user_favorites_alert_sides_check" CHECK ("user_favorites"."alert_sides" in ('buy', 'sell', 'both'));--> statement-breakpoint
ALTER TABLE "user_favorites" ADD CONSTRAINT "user_favorites_alert_min_check" CHECK ("user_favorites"."alert_min_usd" >= 0);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_check" CHECK ("users"."role" in ('user', 'operator', 'admin'));