CREATE TABLE IF NOT EXISTS "admin_audit_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_user_id" integer,
	"event" text NOT NULL,
	"target" text NOT NULL,
	"before_json" jsonb,
	"after_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_audit_logs_created_idx" ON "admin_audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_audit_logs_actor_idx" ON "admin_audit_logs" USING btree ("actor_user_id","created_at");