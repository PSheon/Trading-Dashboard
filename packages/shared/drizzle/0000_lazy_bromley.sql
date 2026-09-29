CREATE TABLE IF NOT EXISTS "actions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chain" text DEFAULT 'hyperliquid' NOT NULL,
	"address" text NOT NULL,
	"coin" text NOT NULL,
	"kind" text NOT NULL,
	"side" text NOT NULL,
	"notional_usd" numeric NOT NULL,
	"avg_px" numeric NOT NULL,
	"leverage" numeric,
	"fill_ids" bigint[] NOT NULL,
	"ts" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "alert_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"kind" text NOT NULL,
	"params_json" jsonb NOT NULL,
	"cooldown_s" integer NOT NULL,
	"quiet_hours" jsonb,
	"tiers" text[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "alerts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"rule_id" integer NOT NULL,
	"chain" text DEFAULT 'hyperliquid' NOT NULL,
	"address" text,
	"coin" text,
	"action_id" bigint,
	"payload_json" jsonb NOT NULL,
	"sent_at" timestamp with time zone,
	"send_status" text DEFAULT 'pending' NOT NULL,
	"px_at_send" numeric,
	"px_1h" numeric,
	"px_4h" numeric,
	"px_24h" numeric
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "coin_meta" (
	"chain" text DEFAULT 'hyperliquid' NOT NULL,
	"coin" text NOT NULL,
	"sz_decimals" integer NOT NULL,
	"max_leverage" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coin_meta_chain_coin_pk" PRIMARY KEY("chain","coin")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "equity_snapshots" (
	"chain" text DEFAULT 'hyperliquid' NOT NULL,
	"address" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"account_value" numeric NOT NULL,
	"total_margin_used" numeric,
	"withdrawable" numeric,
	CONSTRAINT "equity_snapshots_chain_address_ts_pk" PRIMARY KEY("chain","address","ts")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fills" (
	"chain" text DEFAULT 'hyperliquid' NOT NULL,
	"tid" bigint NOT NULL,
	"address" text NOT NULL,
	"coin" text NOT NULL,
	"side" text NOT NULL,
	"dir" text NOT NULL,
	"px" numeric NOT NULL,
	"sz" numeric NOT NULL,
	"fee" numeric NOT NULL,
	"closed_pnl" numeric,
	"hash" text,
	"ts" timestamp with time zone NOT NULL,
	"raw" jsonb NOT NULL,
	CONSTRAINT "fills_chain_tid_pk" PRIMARY KEY("chain","tid")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "leader_list_items" (
	"list_id" integer NOT NULL,
	"address" text NOT NULL,
	"rank" integer NOT NULL,
	"stats_json" jsonb,
	CONSTRAINT "leader_list_items_list_id_address_pk" PRIMARY KEY("list_id","address")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "leader_lists" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"file_name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "leaders" (
	"chain" text DEFAULT 'hyperliquid' NOT NULL,
	"address" text NOT NULL,
	"label" text,
	"tier" text DEFAULT 'B' NOT NULL,
	"notes" text,
	"active" boolean DEFAULT true NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leaders_chain_address_pk" PRIMARY KEY("chain","address")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "position_snapshots" (
	"chain" text DEFAULT 'hyperliquid' NOT NULL,
	"address" text NOT NULL,
	"coin" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"szi" numeric NOT NULL,
	"entry_px" numeric,
	"leverage" numeric,
	"margin_mode" text,
	"unrealized_pnl" numeric,
	"liq_px" numeric,
	CONSTRAINT "position_snapshots_chain_address_coin_ts_pk" PRIMARY KEY("chain","address","coin","ts")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "alerts" ADD CONSTRAINT "alerts_rule_id_alert_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."alert_rules"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "alerts" ADD CONSTRAINT "alerts_action_id_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."actions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "leader_list_items" ADD CONSTRAINT "leader_list_items_list_id_leader_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."leader_lists"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "actions_ts_idx" ON "actions" USING btree ("ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "actions_coin_ts_idx" ON "actions" USING btree ("coin","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "alerts_sent_at_idx" ON "alerts" USING btree ("sent_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "equity_snapshots_address_ts_idx" ON "equity_snapshots" USING btree ("address","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fills_address_ts_idx" ON "fills" USING btree ("address","ts" DESC NULLS LAST);