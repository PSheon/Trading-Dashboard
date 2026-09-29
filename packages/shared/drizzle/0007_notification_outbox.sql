CREATE TABLE IF NOT EXISTS "action_outbox" (
	"action_id" bigint PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notification_cooldowns" (
	"key" text PRIMARY KEY NOT NULL,
	"reserved_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notification_outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"action_id" bigint NOT NULL,
	"user_id" integer NOT NULL,
	"payload_json" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"lease_token" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "action_outbox" ADD CONSTRAINT "action_outbox_action_id_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."actions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_action_id_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."actions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "action_outbox_pending_idx" ON "action_outbox" USING btree ("status","available_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notification_outbox_action_user_uq" ON "notification_outbox" USING btree ("action_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_outbox_pending_idx" ON "notification_outbox" USING btree ("status","available_at");