CREATE TABLE IF NOT EXISTS "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "revenue_snapshots" (
	"address" text NOT NULL,
	"taken_at" timestamp with time zone NOT NULL,
	"builder_rewards" numeric NOT NULL,
	"referral_rewards" numeric NOT NULL,
	"claimed_rewards" numeric NOT NULL,
	"unclaimed_rewards" numeric NOT NULL,
	"referred_users" integer DEFAULT 0 NOT NULL,
	"referred_volume" numeric DEFAULT '0' NOT NULL,
	"raw" jsonb NOT NULL,
	CONSTRAINT "revenue_snapshots_address_taken_at_pk" PRIMARY KEY("address","taken_at")
);
--> statement-breakpoint
ALTER TABLE "trader_stats" ADD COLUMN "is_vault" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "disabled_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
