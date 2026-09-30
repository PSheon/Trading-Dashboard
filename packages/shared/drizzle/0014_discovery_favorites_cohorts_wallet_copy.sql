CREATE TABLE "cohort_members" (
	"chain" text DEFAULT 'hyperliquid' NOT NULL,
	"address" text NOT NULL,
	"tier" text NOT NULL,
	"source" text NOT NULL,
	"rank" integer NOT NULL,
	"pnl_all" numeric,
	"roi_all" numeric,
	"perp_equity" numeric,
	"positions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dexes" text[] DEFAULT '{}'::text[] NOT NULL,
	"fetched_at" timestamp with time zone,
	"swept_at" timestamp with time zone,
	"attempted_at" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "cohort_members_chain_address_pk" PRIMARY KEY("chain","address")
);
--> statement-breakpoint
CREATE TABLE "cohort_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chain" text DEFAULT 'hyperliquid' NOT NULL,
	"tier" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"member_count" integer NOT NULL,
	"wallet_count" integer NOT NULL,
	"notional_long" numeric NOT NULL,
	"notional_short" numeric NOT NULL,
	"long_pct" numeric,
	"upnl_profit" numeric NOT NULL,
	"upnl_loss" numeric NOT NULL,
	"wallets_in_profit" integer NOT NULL,
	"wallets_in_loss" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "copy_consumer_checkpoints" (
	"consumer" text PRIMARY KEY NOT NULL,
	"last_outbox_id" bigint DEFAULT 0 NOT NULL,
	"processed" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "copy_control_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"scope_id" integer NOT NULL,
	"command" text NOT NULL,
	"revision" bigint NOT NULL,
	"actor_user_id" integer,
	"reason" text,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "copy_controls" (
	"scope" text NOT NULL,
	"scope_id" integer NOT NULL,
	"pause_new_risk" boolean DEFAULT false NOT NULL,
	"reduce_only" boolean DEFAULT false NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" integer,
	CONSTRAINT "copy_controls_scope_scope_id_pk" PRIMARY KEY("scope","scope_id")
);
--> statement-breakpoint
CREATE TABLE "copy_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"strategy_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"kind" text NOT NULL,
	"amount" numeric NOT NULL,
	"coin" text,
	"order_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "copy_orders" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"cloid" text NOT NULL,
	"strategy_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"mode" text DEFAULT 'paper' NOT NULL,
	"strategy_version" integer NOT NULL,
	"risk_policy_version" integer NOT NULL,
	"leader_address" text NOT NULL,
	"coin" text NOT NULL,
	"leg" text NOT NULL,
	"side" text NOT NULL,
	"reduce_only" boolean NOT NULL,
	"size" numeric NOT NULL,
	"signal_px" numeric NOT NULL,
	"signal_time" timestamp with time zone NOT NULL,
	"signal_tids" bigint[] NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"control_revisions" jsonb NOT NULL,
	"filled_size" numeric DEFAULT '0' NOT NULL,
	"avg_px" numeric,
	"fee" numeric DEFAULT '0' NOT NULL,
	"builder_fee" numeric DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "copy_orders_cloid_unique" UNIQUE("cloid")
);
--> statement-breakpoint
CREATE TABLE "copy_paper_fills" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"order_id" bigint NOT NULL,
	"strategy_id" integer NOT NULL,
	"coin" text NOT NULL,
	"side" text NOT NULL,
	"size" numeric NOT NULL,
	"px" numeric NOT NULL,
	"base_px" numeric NOT NULL,
	"price_source" text NOT NULL,
	"slippage_bps" numeric NOT NULL,
	"fee" numeric NOT NULL,
	"builder_fee" numeric NOT NULL,
	"realized_pnl" numeric NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "copy_positions" (
	"strategy_id" integer NOT NULL,
	"coin" text NOT NULL,
	"size" numeric NOT NULL,
	"entry_px" numeric NOT NULL,
	"realized_pnl" numeric DEFAULT '0' NOT NULL,
	"funding" numeric DEFAULT '0' NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"funding_through" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "copy_positions_strategy_id_coin_pk" PRIMARY KEY("strategy_id","coin")
);
--> statement-breakpoint
CREATE TABLE "copy_reservations" (
	"order_id" bigint PRIMARY KEY NOT NULL,
	"strategy_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"coin" text NOT NULL,
	"notional" numeric NOT NULL,
	"margin" numeric NOT NULL,
	"status" text DEFAULT 'held' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "copy_risk_policies" (
	"version" serial PRIMARY KEY NOT NULL,
	"limits" jsonb NOT NULL,
	"reason" text,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "copy_signal_legs" (
	"strategy_id" integer NOT NULL,
	"tid" bigint NOT NULL,
	"leg" text NOT NULL,
	"strategy_version" integer NOT NULL,
	"dedupe_key" text NOT NULL,
	"coin" text NOT NULL,
	"fill_time" timestamp with time zone NOT NULL,
	"order_id" bigint,
	"outcome" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "copy_signal_legs_strategy_id_tid_leg_pk" PRIMARY KEY("strategy_id","tid","leg")
);
--> statement-breakpoint
CREATE TABLE "copy_signal_outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chain" text DEFAULT 'hyperliquid' NOT NULL,
	"address" text NOT NULL,
	"tid" bigint NOT NULL,
	"fill_time" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "copy_strategies" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"chain" text DEFAULT 'hyperliquid' NOT NULL,
	"leader_address" text NOT NULL,
	"mode" text DEFAULT 'paper' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"allocated" numeric NOT NULL,
	"cash" numeric NOT NULL,
	"realized_pnl" numeric DEFAULT '0' NOT NULL,
	"fees" numeric DEFAULT '0' NOT NULL,
	"funding" numeric DEFAULT '0' NOT NULL,
	"pause_new_risk" boolean DEFAULT false NOT NULL,
	"reduce_only" boolean DEFAULT false NOT NULL,
	"control_revision" bigint DEFAULT 0 NOT NULL,
	"activated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stopped_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "copy_strategy_versions" (
	"strategy_id" integer NOT NULL,
	"version" integer NOT NULL,
	"settings" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" integer,
	CONSTRAINT "copy_strategy_versions_strategy_id_version_pk" PRIMARY KEY("strategy_id","version")
);
--> statement-breakpoint
CREATE TABLE "kol_avatars" (
	"chain" text DEFAULT 'hyperliquid' NOT NULL,
	"address" text NOT NULL,
	"source" text NOT NULL,
	"bytes" "bytea",
	"content_type" text,
	"etag" text,
	"fetched_at" timestamp with time zone,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	CONSTRAINT "kol_avatars_chain_address_pk" PRIMARY KEY("chain","address")
);
--> statement-breakpoint
CREATE TABLE "paper_accounts" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"balance" numeric NOT NULL,
	"starting_balance" numeric NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_favorite_group_members" (
	"group_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"chain" text DEFAULT 'hyperliquid' NOT NULL,
	"address" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_favorite_group_members_group_id_address_pk" PRIMARY KEY("group_id","address")
);
--> statement-breakpoint
CREATE TABLE "user_favorite_groups" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "embedded_wallet_address" text;--> statement-breakpoint
ALTER TABLE "copy_ledger" ADD CONSTRAINT "copy_ledger_strategy_id_copy_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."copy_strategies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_orders" ADD CONSTRAINT "copy_orders_strategy_id_copy_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."copy_strategies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_paper_fills" ADD CONSTRAINT "copy_paper_fills_order_id_copy_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."copy_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_paper_fills" ADD CONSTRAINT "copy_paper_fills_strategy_id_copy_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."copy_strategies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_positions" ADD CONSTRAINT "copy_positions_strategy_id_copy_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."copy_strategies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_reservations" ADD CONSTRAINT "copy_reservations_order_id_copy_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."copy_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_reservations" ADD CONSTRAINT "copy_reservations_strategy_id_copy_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."copy_strategies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_signal_legs" ADD CONSTRAINT "copy_signal_legs_strategy_id_copy_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."copy_strategies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_strategies" ADD CONSTRAINT "copy_strategies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_strategy_versions" ADD CONSTRAINT "copy_strategy_versions_strategy_id_copy_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."copy_strategies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_accounts" ADD CONSTRAINT "paper_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_favorite_group_members" ADD CONSTRAINT "user_favorite_group_members_group_id_user_favorite_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."user_favorite_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_favorite_group_members" ADD CONSTRAINT "user_favorite_group_members_favorite_fk" FOREIGN KEY ("user_id","chain","address") REFERENCES "public"."user_favorites"("user_id","chain","address") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_favorite_groups" ADD CONSTRAINT "user_favorite_groups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cohort_members_tier_idx" ON "cohort_members" USING btree ("tier","rank");--> statement-breakpoint
CREATE INDEX "cohort_members_attempted_idx" ON "cohort_members" USING btree ("attempted_at");--> statement-breakpoint
CREATE INDEX "cohort_snapshots_tier_ts_idx" ON "cohort_snapshots" USING btree ("chain","tier","ts");--> statement-breakpoint
CREATE INDEX "copy_control_events_created_idx" ON "copy_control_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "copy_ledger_strategy_idx" ON "copy_ledger" USING btree ("strategy_id","id");--> statement-breakpoint
CREATE INDEX "copy_orders_strategy_idx" ON "copy_orders" USING btree ("strategy_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "copy_orders_status_idx" ON "copy_orders" USING btree ("status","id");--> statement-breakpoint
CREATE INDEX "copy_paper_fills_strategy_idx" ON "copy_paper_fills" USING btree ("strategy_id","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "copy_reservations_held_idx" ON "copy_reservations" USING btree ("strategy_id","status");--> statement-breakpoint
CREATE INDEX "copy_signal_legs_coin_time_idx" ON "copy_signal_legs" USING btree ("strategy_id","coin","fill_time");--> statement-breakpoint
CREATE UNIQUE INDEX "copy_signal_outbox_fill_uq" ON "copy_signal_outbox" USING btree ("chain","address","tid");--> statement-breakpoint
CREATE INDEX "copy_signal_outbox_pending_idx" ON "copy_signal_outbox" USING btree ("status","id");--> statement-breakpoint
CREATE INDEX "copy_strategies_user_idx" ON "copy_strategies" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "copy_strategies_leader_idx" ON "copy_strategies" USING btree ("chain","leader_address","status");--> statement-breakpoint
CREATE UNIQUE INDEX "copy_strategies_live_uq" ON "copy_strategies" USING btree ("user_id","chain","leader_address") WHERE status <> 'stopped';--> statement-breakpoint
CREATE INDEX "kol_avatars_next_idx" ON "kol_avatars" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE INDEX "user_favorite_group_members_user_idx" ON "user_favorite_group_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_favorite_groups_user_name_idx" ON "user_favorite_groups" USING btree ("user_id","name");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_embedded_wallet_address_unique" UNIQUE("embedded_wallet_address");