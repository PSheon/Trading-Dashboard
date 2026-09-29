CREATE TABLE IF NOT EXISTS "notification_channels" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"kind" text NOT NULL,
	"target" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trader_stats" (
	"chain" text DEFAULT 'hyperliquid' NOT NULL,
	"address" text NOT NULL,
	"display_name" text,
	"account_value" numeric NOT NULL,
	"pnl_day" numeric NOT NULL,
	"pnl_week" numeric NOT NULL,
	"pnl_month" numeric NOT NULL,
	"pnl_all_time" numeric NOT NULL,
	"roi_day" numeric NOT NULL,
	"roi_week" numeric NOT NULL,
	"roi_month" numeric NOT NULL,
	"roi_all_time" numeric NOT NULL,
	"volume_day" numeric NOT NULL,
	"volume_week" numeric NOT NULL,
	"volume_month" numeric NOT NULL,
	"volume_all_time" numeric NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "trader_stats_chain_address_pk" PRIMARY KEY("chain","address")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_favorites" (
	"user_id" integer NOT NULL,
	"chain" text DEFAULT 'hyperliquid' NOT NULL,
	"address" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_favorites_user_id_chain_address_pk" PRIMARY KEY("user_id","chain","address")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"privy_user_id" text NOT NULL,
	"email" text,
	"wallet_address" text,
	"display_name" text,
	"role" text DEFAULT 'user' NOT NULL,
	"locale" text DEFAULT 'zh-TW' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_privy_user_id_unique" UNIQUE("privy_user_id")
);
--> statement-breakpoint
ALTER TABLE "alert_rules" DROP CONSTRAINT "alert_rules_kind_unique";--> statement-breakpoint
ALTER TABLE "alert_rules" ADD COLUMN "user_id" integer;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "user_id" integer;--> statement-breakpoint
ALTER TABLE "leaders" ADD COLUMN "source" text DEFAULT 'import' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_favorites" ADD CONSTRAINT "user_favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notification_channels_user_kind_uq" ON "notification_channels" USING btree ("user_id","kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trader_stats_pnl_month_idx" ON "trader_stats" USING btree ("pnl_month" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trader_stats_pnl_all_time_idx" ON "trader_stats" USING btree ("pnl_all_time" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trader_stats_account_value_idx" ON "trader_stats" USING btree ("account_value" DESC NULLS LAST);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "alerts" ADD CONSTRAINT "alerts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "alert_rules_user_kind_uq" ON "alert_rules" USING btree ("user_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "alert_rules_default_kind_uq" ON "alert_rules" USING btree ("kind") WHERE "alert_rules"."user_id" is null;