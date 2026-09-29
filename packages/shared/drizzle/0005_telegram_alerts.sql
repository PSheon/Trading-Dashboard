CREATE TABLE IF NOT EXISTS "telegram_link_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "notification_channels" ADD COLUMN "username" text;--> statement-breakpoint
ALTER TABLE "user_favorites" ADD COLUMN "alert_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_favorites" ADD COLUMN "alert_sides" text DEFAULT 'both' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_favorites" ADD COLUMN "alert_min_usd" numeric;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "telegram_link_tokens" ADD CONSTRAINT "telegram_link_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telegram_link_tokens_user_idx" ON "telegram_link_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_favorites_alerting_idx" ON "user_favorites" USING btree ("chain","address") WHERE "user_favorites"."alert_enabled";